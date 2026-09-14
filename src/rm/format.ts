// Reshape Rocket Money's raw GraphQL responses into compact, model-friendly
// summaries. RM returns deeply nested trees with lots of UI-only fields and all
// money in integer CENTS; we flatten to the useful fields and convert to USD.
// Every shaper is defensive: RM can add/rename fields, so we read optionally and
// never throw on a missing key.

type Obj = Record<string, unknown>;

const asObj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Integer cents -> a rounded-to-cents dollars number. */
export function usd(cents: unknown): number | null {
  if (typeof cents !== "number") return null;
  return Math.round(cents) / 100;
}

// Every RM money field is integer cents, including the ones whose names lack the
// usual `Cents` suffix (displayedBalance, currentBalance, available_balance,
// credit_limit, and netWorth/asset/debt on the history rows). Passing one through
// raw reports it 100x, so route them all through usd().

// ── accounts (AccountDetailAccountListPage) ────────────────────────

// RM returns the account list as one connection per account type rather than one
// list. The type is already on each node as `customType`, so the buckets carry no
// information beyond ordering; they only decide which nodes we have to visit.
//
// The buckets overlap: `otherAccounts` repeats nodes that also appear under
// `checkingAccounts` and `savingsAccounts`, byte for byte. Visiting it last means
// the typed buckets are what set each account's position, and the id dedupe below
// drops the repeat. In the 2026-09-13 capture that is 20 edges over 15 accounts.
const ACCOUNT_BUCKETS = [
  "checkingAccounts",
  "savingsAccounts",
  "creditAccounts",
  "investmentAccounts",
  "savingsPlanAccounts",
  "otherAccounts",
] as const;

/**
 * Group every account under the institution that holds it. Each node carries its
 * own `masterAccount` (one linked login at one bank), which is where the
 * institution name and the connection status live - the node's own `institution`
 * has an id but no name. Grouping by masterAccount id keeps two logins at the
 * same bank apart, which is the case a name-keyed grouping would merge.
 */
export function shapeAccounts(data: Obj) {
  const viewer = asObj(asObj(data).viewer);
  const groups = new Map<string, { institution: unknown; status: unknown; accounts: Obj[] }>();
  const seen = new Set<string>();

  for (const bucket of ACCOUNT_BUCKETS) {
    for (const e of asArr(asObj(viewer[bucket]).edges)) {
      const a = asObj(asObj(e).node);
      if (typeof a.id === "string") {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
      }
      const master = asObj(a.masterAccount);
      // Keyed on the account's own id when there is no masterAccount, so an
      // unlinked account lands in a group of one instead of merging into a
      // single nameless bucket with every other one.
      const key = typeof master.id === "string" ? master.id : `account:${String(a.id)}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          institution: asObj(master.institution).name,
          status: master.status,
          accounts: [],
        };
        groups.set(key, group);
      }
      group.accounts.push({
        id: a.id,
        name: a.name ?? a.defaultName,
        type: a.customType,
        mask: a.number,
        balance: usd(a.displayedBalance),
        enabled: a.enabled,
      });
    }
  }

  return { institutions: [...groups.values()] };
}

// ── account detail (AccountDetailPage) ─────────────────────────────
export function shapeAccountDetail(data: Obj) {
  const a = asObj(data.account);
  const liab = asObj(a.liabilityDetails);
  return {
    id: a.id,
    name: a.name,
    category: a.category,
    institution: asObj(a.institution).name,
    mask: a.number,
    currentBalance: usd(a.currentBalance),
    availableBalance: usd(a.available_balance),
    displayedBalance: usd(a.displayedBalance),
    creditLimit: usd(a.credit_limit),
    firstSyncDate: a.firstSyncDate,
    liability: liab.__typename
      ? {
          nextStatementDate: liab.nextStatementDate,
          nextPaymentDueDate: liab.adjustedNextPaymentDueDate,
          statementBalance: usd(liab.remainingStatementBalanceCents),
          lastStatementBalance: usd(liab.lastStatementBalanceCents),
          minimumPayment: usd(liab.remainingMinimumPaymentAmountCents ?? liab.minimumPaymentAmountCents),
          aprs: asArr(liab.aprs).map((x) => {
            const p = asObj(x);
            return {
              type: p.aprType,
              percentage: p.aprPercentage,
              balanceSubjectToApr: usd(p.balanceSubjectToAprCents),
              interestCharge: usd(p.interestChargeAmountCents),
            };
          }),
        }
      : null,
    holdings: asArr(a.holdings).map((h) => {
      const p = asObj(h);
      return {
        ticker: p.tickerSymbol,
        name: p.name,
        quantity: p.quantity,
        value: usd(p.valueCents),
        type: p.type,
      };
    }),
    balanceHistory: asArr(a.sixMonthDailyHistory)
      .map((h) => {
        const p = asObj(h);
        return { date: p.date, balance: usd(p.balanceCents) };
      })
      .slice(-30),
  };
}

// ── net worth (NetWorthQuery) ──────────────────────────────────────
function holdings(list: unknown) {
  return asArr(list).map((x) => {
    const p = asObj(x);
    // Manual assets carry `assetNodeId`; linked accounts carry `accountNodeId`.
    // Surfacing the id is what lets a caller act on what it just read - without
    // it, set_asset_value has nothing to address.
    const assetId = p.assetNodeId ? String(p.assetNodeId) : null;
    const accountId = p.accountNodeId ? String(p.accountNodeId) : null;
    return {
      id: assetId ?? accountId,
      manual: assetId !== null,
      name: p.name,
      value: usd(p.valueCents ?? p.balanceCents),
      limit: usd(p.limitCents),
      institution: asObj(p.institution).name,
      includeInNetWorth: p.includeInNetWorth,
    };
  });
}

export function shapeNetWorth(data: Obj) {
  const nw = asObj(asObj(data.viewer).netWorth);
  const sum = (list: unknown) =>
    holdings(list).reduce((t, h) => t + (h.value ?? 0), 0);
  const cash = sum(nw.cash);
  const savings = sum(nw.savings);
  const investments = sum(nw.investments);
  // `other` holds the hand-entered assets (the vehicle, valuables). Leaving it
  // out understated net worth by their full value - RM's own
  // sixMonthDailyHistory counts them, so the two numbers disagreed.
  const other = sum(nw.other);
  const creditCardDebt = sum(nw.creditCardDebts);
  const longTermDebt = sum(nw.longTermDebts);
  const otherDebt = sum(nw.otherDebts);
  const assets = cash + savings + investments + other;
  const debts = creditCardDebt + longTermDebt + otherDebt;
  // These three are cents too, despite the missing `Cents` suffix; before that was
  // spotted `trend` reported values 100x the `netWorth`/`totals` beside it.
  const history = asArr(nw.sixMonthDailyHistory).map((h) => {
    const p = asObj(h);
    return { date: p.date, netWorth: usd(p.netWorth), asset: usd(p.asset), debt: usd(p.debt) };
  });
  return {
    netWorth: Math.round((assets - debts) * 100) / 100,
    totals: {
      assets, debts, cash, savings, investments, other,
      creditCardDebt, longTermDebt, otherDebt,
    },
    accounts: {
      cash: holdings(nw.cash),
      savings: holdings(nw.savings),
      investments: holdings(nw.investments),
      other: holdings(nw.other),
      creditCardDebts: holdings(nw.creditCardDebts),
      longTermDebts: holdings(nw.longTermDebts),
    },
    // RM returns sixMonthDailyHistory newest-first, so slice(-30) took the 30
    // OLDEST days - six months of stale (often all-zero) rows presented as a
    // recent trend. Take from the head instead.
    trend: history.slice(0, 30),
  };
}

// ── spending (SpendingPage) ────────────────────────────────────────
export function shapeSpending(data: Obj) {
  const v = asObj(data.viewer);
  const byCategory = asArr(v.spendingByCategories)
    .map((x) => {
      const p = asObj(x);
      const cat = asObj(p.transactionCategory);
      return { category: cat.label, type: cat.type, amount: usd(p.amount) };
    })
    .filter((c) => c.amount !== null)
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
  return {
    currentSpent: usd(v.currentSpent),
    previousSpent: usd(v.previousSpent),
    currentEarned: usd(v.currentEarned),
    previousEarned: usd(v.previousEarned),
    currentSpentExcludingBills: usd(v.currentSpentExcludingBills),
    currentBillsUtilities: usd(v.currentBillsUtilities),
    byCategory,
  };
}

// ── budgets (Budgets) ──────────────────────────────────────────────
export function shapeBudgets(data: Obj) {
  const v = asObj(data.viewer);
  const byCategory = asArr(v.spendingByCategories)
    .map((x) => {
      const p = asObj(x);
      const cat = asObj(p.transactionCategory);
      return {
        category: cat.label,
        amount: usd(p.amount),
        lastThreeMonths: asArr(cat.budgetsLastThreeMonthsAmountSpent).map(usd),
      };
    })
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
  return {
    earnings: usd(v.earnings),
    earningsLastMonth: usd(v.earningsLastMonth),
    earningsTwoMonthsAgo: usd(v.earningsTwoMonthsAgo),
    earningsThreeMonthsAgo: usd(v.earningsThreeMonthsAgo),
    byCategory,
  };
}

// ── recurring / subscriptions (RecurringPage) ──────────────────────

// `frequency` is the number of charges per YEAR, not an interval in months, and
// getting that backwards inverts annual and monthly. Read off the 2026-09-13
// capture of 50 recurring nodes: 1 is annual (1Password, charged 2026-08-15,
// next 2027-08-15), 2 is semi-annual (AAA Insurance, charged 2026-04-14, next
// 2026-10-14), and 12 is monthly, which covers 46 of the 50. The other entries
// below follow from the same charges-per-year arithmetic but were not in that
// capture, so an unlisted value falls through to "N times a year" rather than
// being guessed at.
const CADENCE: Record<number, string> = {
  1: "annual",
  2: "semi-annual",
  3: "every 4 months",
  4: "quarterly",
  6: "every 2 months",
  12: "monthly",
  24: "twice a month",
  26: "every 2 weeks",
  52: "weekly",
  365: "daily",
};

/**
 * Human cadence for a `frequency`. A null frequency means Rocket Money has not
 * settled on one - CloudFlare and a card membership fee both carry it, and both
 * have no nextCharge at all - so it reads as "irregular". Never zero, and never
 * silently monthly.
 */
export function cadence(frequency: unknown): string {
  if (typeof frequency !== "number" || !Number.isFinite(frequency)) return "irregular";
  return CADENCE[frequency] ?? `${frequency} times a year`;
}

/** "Bluevine 312.dev LLC Checking 0322" for the account a charge lands on. */
function accountLabel(account: Obj): string | null {
  const parts = [asObj(account.institution).short_name, account.name, account.number]
    .filter(Boolean)
    .map(String);
  return parts.length ? parts.join(" ") : null;
}

/**
 * One recurring charge, flattened.
 *
 * Three fields carry an amount and they mean different things. `amount` on the
 * node is a value someone pinned by hand and is null while RM is still inferring
 * the charge from transactions (48 of 50 nodes in the 2026-09-13 capture);
 * `nextCharge.chargeAmount` is RM's own estimate; `lastTransaction.amount` is
 * what actually posted. `amount` is the first of those that is set, and
 * `amountSource` says which one it came from, so a caller correcting a stale
 * figure can see whether it was pinned or merely predicted.
 */
function shapeSubscriptionNode(n: Obj) {
  const service = asObj(n.service);
  const next = asObj(n.nextCharge);
  const last = asObj(n.lastTransaction);
  const pinned = usd(n.amount);
  const estimated = usd(next.chargeAmount);
  const lastAmount = usd(last.amount);
  const [amount, amountSource] =
    pinned !== null
      ? [pinned, "pinned"]
      : estimated !== null
        ? [estimated, "estimated"]
        : [lastAmount, lastAmount === null ? "unknown" : "lastCharge"];
  return {
    id: n.id,
    name: n.custom_name ?? service.name,
    service: service.name,
    active: n.active,
    cadence: cadence(n.frequency),
    frequency: n.frequency,
    amount,
    amountSource,
    yearlyCost: typeof n.frequency === "number" && amount !== null
      ? Math.round(amount * n.frequency * 100) / 100
      : null,
    category: asObj(n.transactionCategory).label,
    serviceType: n.service_type,
    manual: n.manual,
    isIncome: n.isIncome,
    startDate: n.start_date,
    endDate: n.end_date,
    nextBillDate: n.expected_next_bill_date,
    nextChargeEstimate: estimated,
    estimateFluctuates: next.chargeAmountIsEstimate,
    lastCharge: last.date
      ? { date: last.date, amount: lastAmount, account: accountLabel(asObj(last.account)) }
      : null,
    // Rocket Money's own concierge cancellation offer. Read-only here: knowing
    // which ones RM will cancel for you is useful, filing the request is not
    // something a tool call should be able to do by itself.
    canSubmitCancellationRequest: n.canSubmitCancellationRequest,
  };
}

/**
 * Every recurring charge Rocket Money tracks, active and inactive alike.
 *
 * Inactive ones are kept and flagged rather than dropped: a subscription still
 * listed that last charged over a year ago is exactly what a list audit is
 * looking for, and filtering it out is what let the hand-kept record drift.
 * `activeOnly` exists for /api/budget, which asks a narrower question - what is
 * still being charged - and would otherwise get years of dead rows.
 */
export function shapeRecurring(data: Obj, opts: { activeOnly?: boolean } = {}) {
  const edges = asArr(asObj(asObj(asObj(data).viewer).subscriptions).edges);
  const all = edges.map((e) => shapeSubscriptionNode(asObj(asObj(e).node)));
  const subs = (opts.activeOnly ? all.filter((s) => s.active !== false) : all).sort((a, b) => {
    // Active first, then soonest bill; undated rows sort last within their group
    // instead of leading, which is what an empty string would have done.
    if (a.active !== b.active) return a.active === false ? 1 : -1;
    const ad = String(a.nextBillDate ?? "9999-12-31");
    const bd = String(b.nextBillDate ?? "9999-12-31");
    return ad.localeCompare(bd);
  });
  return {
    count: subs.length,
    activeCount: subs.filter((s) => s.active !== false).length,
    inactiveCount: subs.filter((s) => s.active === false).length,
    subscriptions: subs,
  };
}

// ── one subscription (SubscriptionDetailPage) ──────────────────────

/**
 * One recurring charge in full. Everything the list row carries, plus the charge
 * history that says whether the cadence on file is the one the merchant is
 * actually billing: RM's own yearly cost, a 12-month by-month total, and the
 * individual transactions.
 */
export function shapeSubscriptionDetail(data: Obj) {
  const n = asObj(data.node);
  const txns = asArr(asObj(n.transactions).edges).map((e) => {
    const t = asObj(asObj(e).node);
    return {
      id: t.id,
      date: t.date,
      amount: usd(t.amount),
      name: t.longName ?? t.shortName,
      pending: t.pending,
      account: accountLabel(asObj(t.account)),
    };
  });
  return {
    ...shapeSubscriptionNode(n),
    // RM's own annualized figure, which is worth keeping beside our computed
    // yearlyCost: the two disagreeing means the cadence or the amount is wrong.
    rocketMoneyYearlyCost: usd(n.yearlyCost),
    transactionCount: n.transaction_count,
    monthlyTotals: asArr(n.monthlyTransactionsBarChartData).map((b) => {
      const p = asObj(b);
      return { month: p.date, amount: usd(p.amountCents) };
    }),
    relatedSubscriptions: asArr(n.relatedSubscriptions).map((r) => {
      const p = asObj(r);
      return { id: p.id, name: p.custom_name ?? asObj(p.service).name };
    }),
    transactions: txns,
  };
}

// ── upcoming charges (RecurringUpcomingPage) ───────────────────────
export function shapeUpcoming(data: Obj) {
  const items = asArr(asObj(data.viewer).subscriptionCalendarItems).map((x) => {
    const p = asObj(x);
    const sub = asObj(p.subscription);
    return {
      date: p.chargeDate,
      amount: usd(p.chargeAmount),
      isEstimate: p.chargeAmountIsEstimate,
      status: p.paymentStatus,
      name: sub.custom_name ?? asObj(sub.service).name,
    };
  });
  const total = items.reduce((t, i) => t + (i.amount ?? 0), 0);
  return { count: items.length, totalUpcoming: Math.round(total * 100) / 100, items };
}
