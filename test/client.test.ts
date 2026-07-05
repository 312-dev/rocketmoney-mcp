import { test } from "node:test";
import assert from "node:assert/strict";
import { toNodeId, collectByType, findByType } from "../src/rm/client.js";

test("toNodeId produces Relay base64 ids matching Rocket Money", () => {
  // Anchor: this exact base64 appeared in the HAR for account 425453743.
  assert.equal(toNodeId("Account", 425453743), "QWNjb3VudDo0MjU0NTM3NDM=");
  assert.equal(toNodeId("TransactionCategory", 2), "VHJhbnNhY3Rpb25DYXRlZ29yeToy");
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
