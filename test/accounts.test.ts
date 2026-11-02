// session_status's stale-connection check, against fake account and search reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { staleConnectionsNow } from "../src/tools/accounts.js";

const node = (id: string, status: string, name: string) => ({
  node: { id, name, number: "0000", masterAccount: { id: `m-${id}`, status, institution: { name } } },
});

test("staleConnectionsNow reports disconnected institutions with where their data stops", async () => {
  const out = await staleConnectionsNow({
    getAccounts: async () => ({
      viewer: {
        creditAccounts: { edges: [node("ok1", "ok", "Chase"), node("amz", "disconnected", "Amazon.com Store Card")] },
      },
    }),
    lastDate: async (id) => (id === "amz" ? "2026-01-18" : "2026-11-01"),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].institution, "Amazon.com Store Card");
  assert.equal(out[0].accounts[0].last_transaction, "2026-01-18");
});
