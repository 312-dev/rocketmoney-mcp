import { test } from "node:test";
import assert from "node:assert/strict";
import { RMAuthError, retryAfterRelogin } from "../src/rm/client.js";

test("retryAfterRelogin re-runs the request once after a successful re-login", async () => {
  let calls = 0;
  const run = async () => {
    calls++;
    if (calls === 1) throw new RMAuthError("session died");
    return "data";
  };
  assert.equal(await retryAfterRelogin(run, async () => ({ ok: true }), 1000), "data");
  assert.equal(calls, 2);
});

test("retryAfterRelogin gives back the auth error when the re-login fails or takes too long", async () => {
  const dead = async () => {
    throw new RMAuthError("session died");
  };
  await assert.rejects(retryAfterRelogin(dead, async () => ({ ok: false }), 1000), /session died/);
  const slow = () => new Promise<{ ok: boolean }>((r) => setTimeout(() => r({ ok: true }), 200));
  await assert.rejects(retryAfterRelogin(dead, slow, 10), /session died/);
});

test("retryAfterRelogin doesn't re-login for errors other than a dead session", async () => {
  let relogins = 0;
  const broken = async () => {
    throw new Error("PersistedQueryNotFound");
  };
  await assert.rejects(retryAfterRelogin(broken, async () => (relogins++, { ok: true }), 1000), /PersistedQueryNotFound/);
  assert.equal(relogins, 0);
});
