import { test } from "node:test";
import assert from "node:assert/strict";
import {
  usd,
  shapeAccounts,
  shapeNetWorth,
  shapeSpending,
  shapeBudgets,
  shapeRecurring,
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

test("shapeAccounts flattens institutions -> accounts with displayed balance", () => {
  const out = shapeAccounts({
    viewer: {
      masterAccounts: {
        edges: [
          {
            node: {
              status: "connected",
              institution: { name: "Chase" },
              accounts: {
                edges: [
                  {
                    node: {
                      id: "acc1",
                      name: "Checking",
                      defaultName: "CHK",
                      customType: "checking",
                      number: "1234",
                      displayedBalance: 4200.5,
                      enabled: true,
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    },
  });
  assert.equal(out.institutions.length, 1);
  assert.equal(out.institutions[0].institution, "Chase");
  assert.equal(out.institutions[0].accounts[0].name, "Checking");
  assert.equal(out.institutions[0].accounts[0].balance, 4200.5);
  assert.equal(out.institutions[0].accounts[0].mask, "1234");
});

test("shapeAccounts falls back to defaultName when name is missing", () => {
  const out = shapeAccounts({
    viewer: {
      masterAccounts: {
        edges: [{ node: { institution: {}, accounts: { edges: [{ node: { defaultName: "Savings" } }] } } }],
      },
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

test("shapeRecurring lists active subs sorted by next bill date", () => {
  const out = shapeRecurring({
    viewer: {
      subscriptions: {
        edges: [
          { node: { custom_name: "Netflix", active: true, service: { name: "Netflix" }, transactionCategory: { label: "Entertainment" }, expected_next_bill_date: "2026-07-20", nextCharge: { chargeAmount: 1599, chargeAmountIsEstimate: false } } },
          { node: { custom_name: "Spotify", active: true, service: { name: "Spotify" }, transactionCategory: { label: "Entertainment" }, expected_next_bill_date: "2026-07-10", nextCharge: { chargeAmount: 1199 } } },
          { node: { custom_name: "Old Gym", active: false, service: { name: "Gym" } } },
        ],
      },
    },
  });
  assert.equal(out.count, 2); // inactive dropped
  assert.equal(out.subscriptions[0].name, "Spotify"); // 07-10 before 07-20
  assert.equal(out.subscriptions[0].nextChargeEstimate, 11.99);
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
      currentBalance: 1200,
      credit_limit: 10000,
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
});

test("shapers never throw on empty/garbage input", () => {
  for (const fn of [shapeAccounts, shapeNetWorth, shapeSpending, shapeBudgets, shapeRecurring, shapeUpcoming, shapeAccountDetail]) {
    assert.doesNotThrow(() => fn({}));
    assert.doesNotThrow(() => fn({ viewer: null } as never));
  }
});
