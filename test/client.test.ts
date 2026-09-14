import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toNodeId,
  fromNodeId,
  collectByType,
  findByType,
  buildSubscriptionUpdateInput,
} from "../src/rm/client.js";

test("toNodeId produces Relay base64 ids matching Rocket Money", () => {
  // Anchor: this exact base64 appeared in the HAR for account 425453743.
  assert.equal(toNodeId("Account", 425453743), "QWNjb3VudDo0MjU0NTM3NDM=");
  assert.equal(toNodeId("TransactionCategory", 2), "VHJhbnNhY3Rpb25DYXRlZ29yeToy");
});

test("fromNodeId decodes real Rocket Money category node ids", () => {
  // Anchors captured from app.rocketmoney.com.har (2026-07-05).
  assert.deepEqual(fromNodeId("VHJhbnNhY3Rpb25DYXRlZ29yeToy"), {
    type: "TransactionCategory",
    numericId: "2",
  }); // Bills & Utilities
  assert.deepEqual(fromNodeId("VHJhbnNhY3Rpb25DYXRlZ29yeTo2MTE1NDc2"), {
    type: "TransactionCategory",
    numericId: "6115476",
  }); // Therapy (custom)
  // Round-trips with toNodeId.
  assert.equal(fromNodeId(toNodeId("Transaction", "103172582916"))?.numericId, "103172582916");
});

test("fromNodeId rejects non-node-id input instead of guessing", () => {
  assert.equal(fromNodeId("Groceries"), null); // a label, not a node id
  assert.equal(fromNodeId("11"), null); // a bare numeric id, not base64
  assert.equal(fromNodeId(""), null);
});

test("collectByType gathers every node of a __typename anywhere in the tree", () => {
  const tree = {
    viewer: {
      transactions: {
        edges: [
          { node: { __typename: "Transaction", id: "t1", amount: 1299 } },
          { node: { __typename: "Transaction", id: "t2", amount: -500 } },
        ],
      },
      nested: { deeper: { __typename: "Transaction", id: "t3", amount: 42 } },
      unrelated: { __typename: "Account", id: "a1" },
    },
  };
  const out: Record<string, unknown>[] = [];
  collectByType(tree, "Transaction", out);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((o) => o.id).sort(), ["t1", "t2", "t3"]);
});

test("findByType returns the first matching node or null", () => {
  const tree = { a: { b: { __typename: "PageInfo", hasNextPage: true } } };
  assert.equal(findByType(tree, "PageInfo")?.hasNextPage, true);
  assert.equal(findByType(tree, "Nope"), null);
  assert.equal(findByType(null, "X"), null);
});

// UpdateSubscription replaces the whole record, so the builder's job is to carry
// forward everything the caller did not name. Shapes only - no real figures.
const subNode = {
  id: "U3Vic2NyaXB0aW9uOjE=",
  custom_name: "Streaming Co",
  service: { _id: 77, name: "Streaming Co" },
  amount: 1500,
  frequency: 12,
  start_date: "2025-01-05",
  end_date: "2026-06-05",
  expected_next_bill_date: "2026-07-05",
  service_type: "subscription",
};

test("buildSubscriptionUpdateInput preserves every field the caller left alone", () => {
  assert.deepEqual(buildSubscriptionUpdateInput(subNode, { frequency: 1 }), {
    id: "U3Vic2NyaXB0aW9uOjE=",
    service_name: "Streaming Co",
    service_id: 77,
    amount: 1500,
    frequency: 1, // the only change
    start_date: "2025-01-05",
    end_date: "2026-06-05",
    next_expected_date: "2026-07-05",
    service_type: "subscription",
  });
});

test("buildSubscriptionUpdateInput sends cents and leaves an unpinned amount alone", () => {
  assert.equal(buildSubscriptionUpdateInput(subNode, { amountCents: 4788 }).amount, 4788);
  // RM leaves `amount` null while it infers the charge from transactions.
  // Inventing a null to send would pin it; omitting the key does not.
  const inferred = { ...subNode, amount: null };
  assert.equal("amount" in buildSubscriptionUpdateInput(inferred), false);
  assert.equal(buildSubscriptionUpdateInput(inferred, { amountCents: 0 }).amount, 0);
});

test("buildSubscriptionUpdateInput falls back to the service name, then refuses", () => {
  const unnamed = { ...subNode, custom_name: null };
  assert.equal(buildSubscriptionUpdateInput(unnamed).service_name, "Streaming Co");
  assert.equal(buildSubscriptionUpdateInput(unnamed, { name: "Renamed" }).service_name, "Renamed");
  // service_name is String! - a record with no name at all cannot be written.
  assert.throws(() => buildSubscriptionUpdateInput({ id: "x", service: {} }), /service_name is required/);
});
