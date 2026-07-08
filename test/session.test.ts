import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCookieHeader,
  serializeJar,
  applySetCookies,
  seedSession,
  loadSession,
  saveSession,
  markSessionDead,
  sessionStatus,
} from "../src/rm/session.js";

// Point the (lazily-resolved) state dir at a fresh temp dir per test.
beforeEach(() => {
  process.env.ROCKETMONEY_STATE_DIR = mkdtempSync(join(tmpdir(), "rm-sess-"));
});

test("parseCookieHeader / serializeJar round-trip", () => {
  const jar = parseCookieHeader("tb.auth0.sid=abc; AWSALB=xyz; other=1");
  assert.equal(jar.get("tb.auth0.sid"), "abc");
  assert.equal(jar.get("AWSALB"), "xyz");
  assert.equal(serializeJar(jar), "tb.auth0.sid=abc; AWSALB=xyz; other=1");
});

test("applySetCookies rotates values and ignores deletions", () => {
  const jar = parseCookieHeader("tb.auth0.sid=old; AWSALB=a");
  applySetCookies(jar, [
    "tb.auth0.sid=new; Path=/; HttpOnly; Secure",
    "AWSALB=deleted; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "AWSALBCORS=fresh; Path=/",
  ]);
  assert.equal(jar.get("tb.auth0.sid"), "new"); // rotated
  assert.equal(jar.get("AWSALB"), "a"); // deletion ignored, kept old
  assert.equal(jar.get("AWSALBCORS"), "fresh"); // new cookie added
});

test("seedSession rejects only empty / whitespace input", () => {
  const err = seedSession("   ");
  assert.ok(err);
  assert.equal(loadSession(), null);
  assert.equal(sessionStatus().status, "missing");
});

test("seedSession accepts a bare tb.auth0.sid value (no k=v required)", () => {
  const err = seedSession("  rawSidValue123  ");
  assert.equal(err, null);
  assert.equal(loadSession()?.get("tb.auth0.sid"), "rawSidValue123");
  assert.equal(sessionStatus().status, "live");
});

test("seedSession accepts a valid cookie and marks the session live", () => {
  const err = seedSession("tb.auth0.sid=abc123; AWSALB=z");
  assert.equal(err, null);
  const jar = loadSession();
  assert.ok(jar);
  assert.equal(jar?.get("tb.auth0.sid"), "abc123");
  assert.equal(sessionStatus().status, "live");
});

test("saveSession persists the rotated jar; loadSession reads it back", () => {
  seedSession("tb.auth0.sid=abc");
  const jar = loadSession()!;
  applySetCookies(jar, ["tb.auth0.sid=rotated"]);
  saveSession(jar);
  assert.equal(loadSession()?.get("tb.auth0.sid"), "rotated");
});

test("markSessionDead blocks loadSession until re-seeded", () => {
  seedSession("tb.auth0.sid=abc");
  markSessionDead("HTTP 401 on SettingsAccountsPage");
  assert.equal(loadSession(), null); // dead sessions don't load
  const s = sessionStatus();
  assert.equal(s.status, "dead");
  assert.match(String(s.lastError), /401/);
  // A fresh paste revives it.
  seedSession("tb.auth0.sid=fresh");
  assert.equal(loadSession()?.get("tb.auth0.sid"), "fresh");
  assert.equal(sessionStatus().status, "live");
});
