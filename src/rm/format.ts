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

/** Some RM fields are already dollars (displayedBalance); pass through as number. */
function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

// ── accounts (SettingsAccountsPage) ────────────────────────────────
export function shapeAccounts(data: Obj) {
  const edges = asArr(asObj(asObj(asObj(data).viewer).masterAccounts).edges);
  const institutions = edges.map((e) => {
    const node = asObj(asObj(e).node);
    const inst = asObj(node.institution);
    const accts = asArr(asObj(node.accounts).edges).map((ae) => {
      const a = asObj(asObj(ae).node);
      return {
        id: a.id,
        name: a.name ?? a.defaultName,
        type: a.customType,
        mask: a.number,
        balance: num(a.displayedBalance),
        enabled: a.enabled,
      };
    });
    return {
      institution: inst.name,
      status: node.status,
      accounts: accts,
    };
  });
  return { institutions };
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
    currentBalance: num(a.currentBalance),
    availableBalance: num(a.available_balance),
    displayedBalance: num(a.displayedBalance),
    creditLimit: num(a.credit_limit),
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
    return {
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
  const creditCardDebt = sum(nw.creditCardDebts);
  const longTermDebt = sum(nw.longTermDebts);
  const otherDebt = sum(nw.otherDebts);
  const assets = cash + savings + investments;
  const debts = creditCardDebt + longTermDebt + otherDebt;
  const history = asArr(nw.sixMonthDailyHistory).map((h) => {
    const p = asObj(h);
    return { date: p.date, netWorth: num(p.netWorth), asset: num(p.asset), debt: num(p.debt) };
  });
  return {
    netWorth: Math.round((assets - debts) * 100) / 100,
    totals: { assets, debts, cash, savings, investments, creditCardDebt, longTermDebt, otherDebt },
    accounts: {
      cash: holdings(nw.cash),
      savings: holdings(nw.savings),
      investments: holdings(nw.investments),
      creditCardDebts: holdings(nw.creditCardDebts),
      longTermDebts: holdings(nw.longTermDebts),
    },
    trend: history.slice(-30),
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
export function shapeRecurring(data: Obj) {
  const edges = asArr(asObj(asObj(asObj(data).viewer).subscriptions).edges);
  const subs = edges
    .map((e) => {
      const n = asObj(asObj(e).node);
      const next = asObj(n.nextCharge);
      return {
        name: n.custom_name ?? asObj(n.service).name,
        service: asObj(n.service).name,
        active: n.active,
        isIncome: n.isIncome,
        category: asObj(n.transactionCategory).label,
        nextBillDate: n.expected_next_bill_date,
        nextChargeEstimate: usd(next.chargeAmount),
        estimateFluctuates: next.chargeAmountIsEstimate,
      };
    })
    .filter((s) => s.active !== false)
    .sort((a, b) => String(a.nextBillDate ?? "").localeCompare(String(b.nextBillDate ?? "")));
  return { count: subs.length, subscriptions: subs };
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
