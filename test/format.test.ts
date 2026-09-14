import { test } from "node:test";
import assert from "node:assert/strict";
import {
  usd,
  shapeAccounts,
  shapeNetWorth,
  shapeSpending,
  shapeBudgets,
  shapeRecurring,
  shapeSubscriptionDetail,
  cadence,
  shapeUpcoming,
  shapeAccountDetail,
} from "../src/rm/format.js";

test("usd converts integer cents to dollars, tolerates non-numbers", () => {
  assert.equal(usd(33578), 335.78); // a real subscriptions history value from the HAR
  assert.equal(usd(0), 0);
  assert.equal(usd(-1299), -12.99);
  assert.equal(usd(null), null);
  assert.equal(usd(undefined), null);
  assert.equal(usd("100"), null);
});

// RM hands back one connection per account type, each node naming its own
// masterAccount; shapeAccounts regroups that institution-first.
const masterChase = {
  id: "ma1",
  status: "connected",
  institution: { name: "Chase" },
};

test("shapeAccounts regroups the per-type buckets under their institution", () => {
  const out = shapeAccounts({
    viewer: {
      checkingAccounts: {
        edges: [
          {
            node: {
              id: "acc1",
              name: "Checking",
              defaultName: "CHK",
              customType: "checking",
              number: "1234",
              displayedBalance: 420050,
              enabled: true,
              masterAccount: masterChase,
            },
          },
        ],
      },
      creditAccounts: {
        edges: [
          {
            node: {
              id: "acc2",
              name: "Sapphire",
              customType: "credit",
              number: "5678",
              displayedBalance: -31000,
              enabled: true,
              masterAccount: masterChase,
            },
          },
        ],
      },
    },
  });
  assert.equal(out.institutions.length, 1);
  assert.equal(out.institutions[0].institution, "Chase");
  assert.equal(out.institutions[0].status, "connected");
  assert.equal(out.institutions[0].accounts.length, 2);
  assert.equal(out.institutions[0].accounts[0].name, "Checking");
  assert.equal(out.institutions[0].accounts[0].balance, 4200.5); // 420050 cents
  assert.equal(out.institutions[0].accounts[0].mask, "1234");
  assert.equal(out.institutions[0].accounts[1].type, "credit");
});

test("shapeAccounts lists an account once when otherAccounts repeats it", () => {
  const node = { id: "acc1", name: "Checking", customType: "checking", masterAccount: masterChase };
  const out = shapeAccounts({
    viewer: {
      checkingAccounts: { edges: [{ node }] },
      otherAccounts: { edges: [{ node }] },
    },
  });
  assert.equal(out.institutions.length, 1);
  assert.equal(out.institutions[0].accounts.length, 1);
});

test("shapeAccounts keeps two logins at the same bank apart", () => {
  const out = shapeAccounts({
    viewer: {
      savingsAccounts: {
        edges: [
          { node: { id: "a", masterAccount: { id: "ma1", institution: { name: "Ally" } } } },
          { node: { id: "b", masterAccount: { id: "ma2", institution: { name: "Ally" } } } },
        ],
      },
    },
  });
  assert.equal(out.institutions.length, 2);
});

test("shapeAccounts falls back to defaultName when name is missing", () => {
  const out = shapeAccounts({
    viewer: {
      savingsAccounts: { edges: [{ node: { id: "acc1", defaultName: "Savings" } }] },
    },
  });
  assert.equal(out.institutions[0].accounts[0].name, "Savings");
});

test("shapeNetWorth sums assets and debts from cents and computes net worth", () => {
  const out = shapeNetWorth({
    viewer: {
      netWorth: {
        cash: [{ name: "Checking", valueCents: 500000, institution: { name: "Chase" }, includeInNetWorth: true }],
        savings: [{ name: "HYSA", valueCents: 1000000, institution: { name: "Ally" } }],
        investments: [{ name: "401k", valueCents: 2500000, institution: { name: "Fidelity" } }],
        creditCardDebts: [{ name: "Sapphire", balanceCents: 120000, limitCents: 1000000, institution: { name: "Chase" } }],
        longTermDebts: [{ name: "Auto", valueCents: 800000, institution: { name: "Toyota" } }],
        otherDebts: [],
        sixMonthDailyHistory: [{ date: "2026-07-01", netWorth: 30000, asset: 40000, debt: 10000 }],
      },
    },
  });
  // assets = 5000 + 10000 + 25000 = 40000 ; debts = 1200 + 8000 = 9200
  assert.equal(out.totals.assets, 40000);
  assert.equal(out.totals.debts, 9200);
  assert.equal(out.netWorth, 30800);
  assert.equal(out.accounts.creditCardDebts[0].limit, 10000);
  assert.equal(out.trend.length, 1);
});

test("shapeSpending sorts categories by amount descending and converts cents", () => {
  const out = shapeSpending({
    viewer: {
      currentSpent: 250000,
      previousSpent: 200000,
      currentEarned: 800000,
      spendingByCategories: [
        { amount: 5000, transactionCategory: { label: "Coffee", type: "expense" } },
        { amount: 90000, transactionCategory: { label: "Rent", type: "expense" } },
        { amount: 30000, transactionCategory: { label: "Groceries", type: "expense" } },
      ],
    },
  });
  assert.equal(out.currentSpent, 2500);
  assert.equal(out.currentEarned, 8000);
  assert.deepEqual(
    out.byCategory.map((c) => c.category),
    ["Rent", "Groceries", "Coffee"],
  );
  assert.equal(out.byCategory[0].amount, 900);
});

test("shapeBudgets exposes earnings and 3-month category trend", () => {
  const out = shapeBudgets({
    viewer: {
      earnings: 800000,
      earningsLastMonth: 790000,
      spendingByCategories: [
        { amount: 40000, transactionCategory: { label: "Groceries", budgetsLastThreeMonthsAmountSpent: [38000, 42000, 40000] } },
      ],
    },
  });
  assert.equal(out.earnings, 8000);
  assert.deepEqual(out.byCategory[0].lastThreeMonths, [380, 420, 400]);
});

const recurringFixture = {
  viewer: {
    subscriptions: {
      edges: [
        { node: { id: "s1", custom_name: "Netflix", active: true, frequency: 12, amount: null, service: { name: "Netflix", _id: 1 }, transactionCategory: { label: "Entertainment" }, expected_next_bill_date: "2026-07-20", nextCharge: { chargeAmount: 1599, chargeAmountIsEstimate: false }, lastTransaction: { date: "2026-06-20", amount: 1599, account: { name: "Everyday", number: "1111", institution: { short_name: "Chase" } } }, canSubmitCancellationRequest: true } },
        { node: { id: "s2", custom_name: "Spotify", active: true, frequency: 12, amount: 1199, service: { name: "Spotify", _id: 2 }, transactionCategory: { label: "Entertainment" }, expected_next_bill_date: "2026-07-10", nextCharge: { chargeAmount: 1199 } } },
        { node: { id: "s3", custom_name: "Old Gym", active: false, frequency: 12, service: { name: "Gym", _id: 3 }, expected_next_bill_date: "2026-07-01" } },
        { node: { id: "s4", custom_name: "Metered API", active: true, frequency: null, service: { name: "Metered API", _id: 4 }, lastTransaction: { date: "2026-06-02", amount: 812 } } },
      ],
    },
  },
};

test("shapeRecurring keeps inactive subs, flagged, and sorts active first", () => {
  const out = shapeRecurring(recurringFixture);
  assert.equal(out.count, 4);
  assert.equal(out.activeCount, 3);
  assert.equal(out.inactiveCount, 1);
  // Active first, then soonest bill; the inactive row's earlier date does not
  // pull it to the top, and the undated one sorts last among the active.
  assert.deepEqual(out.subscriptions.map((s) => s.name), ["Spotify", "Netflix", "Metered API", "Old Gym"]);
  assert.equal(out.subscriptions[3].active, false);
  assert.equal(out.subscriptions[1].lastCharge?.account, "Chase Everyday 1111");
  assert.equal(out.subscriptions[1].canSubmitCancellationRequest, true);
});

test("shapeRecurring reports the amount it has and says where it came from", () => {
  const byName = new Map(shapeRecurring(recurringFixture).subscriptions.map((s) => [s.name, s]));
  // A hand-pinned amount wins over the estimate.
  assert.equal(byName.get("Spotify")?.amount, 11.99);
  assert.equal(byName.get("Spotify")?.amountSource, "pinned");
  // Null amount falls through to RM's own next-charge estimate...
  assert.equal(byName.get("Netflix")?.amount, 15.99);
  assert.equal(byName.get("Netflix")?.amountSource, "estimated");
  // ...and then to what actually posted.
  assert.equal(byName.get("Metered API")?.amount, 8.12);
  assert.equal(byName.get("Metered API")?.amountSource, "lastCharge");
  // Yearly cost is amount x charges per year, and is unknowable without a cadence.
  assert.equal(byName.get("Spotify")?.yearlyCost, 143.88);
  assert.equal(byName.get("Metered API")?.yearlyCost, null);
});

test("shapeRecurring activeOnly restores the narrower list /api/budget wants", () => {
  const out = shapeRecurring(recurringFixture, { activeOnly: true });
  assert.equal(out.count, 3);
  assert.equal(out.inactiveCount, 0);
  assert.ok(!out.subscriptions.some((s) => s.name === "Old Gym"));
});

test("cadence reads frequency as charges per year, not months", () => {
  assert.equal(cadence(12), "monthly");
  assert.equal(cadence(1), "annual");
  assert.equal(cadence(2), "semi-annual");
  assert.equal(cadence(4), "quarterly");
  // Anything unlisted is spelled out rather than guessed at.
  assert.equal(cadence(9), "9 times a year");
  // No cadence on file means irregular, never zero and never monthly.
  assert.equal(cadence(null), "irregular");
  assert.equal(cadence(undefined), "irregular");
  assert.equal(cadence("12"), "irregular");
});

test("shapeSubscriptionDetail adds charge history to the list row", () => {
  const out = shapeSubscriptionDetail({
    node: {
      id: "s1",
      custom_name: "Netflix",
      active: true,
      frequency: 12,
      amount: 1599,
      service: { name: "Netflix", _id: 1 },
      yearlyCost: 19188,
      transaction_count: 12,
      monthlyTransactionsBarChartData: [{ date: "2026-06-01", amountCents: 1599 }],
      relatedSubscriptions: [{ id: "s9", service: { name: "Netflix Extra Member" } }],
      transactions: {
        edges: [
          { node: { id: "t1", date: "2026-06-20", amount: 1599, longName: "NETFLIX.COM", pending: false, account: { name: "Everyday", number: "1111", institution: { short_name: "Chase" } } } },
        ],
      },
    },
  });
  assert.equal(out.name, "Netflix");
  assert.equal(out.amount, 15.99);
  assert.equal(out.cadence, "monthly");
  // RM's own annualized figure and ours are both dollars, and agree here.
  assert.equal(out.rocketMoneyYearlyCost, 191.88);
  assert.equal(out.yearlyCost, 191.88);
  assert.equal(out.transactionCount, 12);
  assert.equal(out.monthlyTotals[0].amount, 15.99);
  assert.equal(out.relatedSubscriptions[0].name, "Netflix Extra Member");
  assert.equal(out.transactions[0].account, "Chase Everyday 1111");
});

test("shapeUpcoming totals upcoming charges", () => {
  const out = shapeUpcoming({
    viewer: {
      subscriptionCalendarItems: [
        { chargeDate: "2026-07-10", chargeAmount: 1199, paymentStatus: "upcoming", subscription: { custom_name: "Spotify" } },
        { chargeDate: "2026-07-20", chargeAmount: 1599, chargeAmountIsEstimate: true, subscription: { service: { name: "Netflix" } } },
      ],
    },
  });
  assert.equal(out.count, 2);
  assert.equal(out.totalUpcoming, 27.98);
  assert.equal(out.items[1].name, "Netflix"); // falls back to service name
});

test("shapeAccountDetail surfaces liability APRs and converts cents", () => {
  const out = shapeAccountDetail({
    account: {
      id: "acc1",
      name: "Sapphire",
      category: "credit",
      institution: { name: "Chase" },
      number: "9999",
      currentBalance: 120000,
      available_balance: 880000,
      displayedBalance: 120000,
      credit_limit: 1000000,
      liabilityDetails: {
        __typename: "LiabilityDetails",
        remainingStatementBalanceCents: 120000,
        minimumPaymentAmountCents: 3500,
        aprs: [{ aprType: "purchase", aprPercentage: 24.99, balanceSubjectToAprCents: 120000, interestChargeAmountCents: 2400 }],
      },
      sixMonthDailyHistory: [{ date: "2026-07-01", balanceCents: 120000 }],
    },
  });
  assert.equal(out.liability?.statementBalance, 1200);
  assert.equal(out.liability?.minimumPayment, 35);
  assert.equal(out.liability?.aprs[0].percentage, 24.99);
  assert.equal(out.balanceHistory[0].balance, 1200);
  // The balances carry no `Cents` suffix but are cents all the same. The tell is
  // inside one response: a same-day history row and currentBalance must agree.
  assert.equal(out.currentBalance, 1200);
  assert.equal(out.currentBalance, out.balanceHistory[0].balance);
  assert.equal(out.availableBalance, 8800);
  assert.equal(out.displayedBalance, 1200);
  assert.equal(out.creditLimit, 10000);
});

test("shapers never throw on empty/garbage input", () => {
  for (const fn of [shapeAccounts, shapeNetWorth, shapeSpending, shapeBudgets, shapeRecurring, shapeSubscriptionDetail, shapeUpcoming, shapeAccountDetail]) {
    assert.doesNotThrow(() => fn({}));
    assert.doesNotThrow(() => fn({ viewer: null } as never));
  }
});
