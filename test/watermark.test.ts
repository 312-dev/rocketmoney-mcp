import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWatermark, nextSince, unseen, commit, resetWatermark, validSlug } from "../src/rm/watermark.js";
import type { RMTransaction } from "../src/rm/client.js";

// Point the (lazily-resolved) state dir at a fresh temp dir per test.
beforeEach(() => {
  process.env.ROCKETMONEY_STATE_DIR = mkdtempSync(join(tmpdir(), "rm-wm-"));
});

const txn = (id: string, date: string, name = "Merchant"): RMTransaction => ({
  nodeId: id,
  amountCents: -1234,
  date,
  note: null,
  name,
  categoryLabel: "Groceries",
});

const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

test("first-ever call looks back one window from today", () => {
  const row = loadWatermark();
  assert.equal(row.lastCheckedAt, null);
  assert.equal(nextSince(row, at("2026-07-19")), "2026-07-12"); // 7-day default
});

test("the window is anchored on the last check, so a long gap is covered", () => {
  commit("2026-06-01", [], at("2026-06-08"));
  // Polling resumes 6 weeks later: the window must reach back to the last
  // check, not just 7 days from today, or the gap is silently skipped.
  assert.equal(nextSince(loadWatermark(), at("2026-07-19")), "2026-06-01");
});

test("a future-dated persisted check cannot push the window forward", () => {
  commit("2026-07-01", [], at("2027-01-01")); // clock skew / bad state
  assert.equal(nextSince(loadWatermark(), at("2026-07-19")), "2026-07-12");
});

test("committed transactions are not returned again", () => {
  const first = [txn("a", "2026-07-18"), txn("b", "2026-07-18")];
  assert.deepEqual(unseen(loadWatermark(), first).map((t) => t.nodeId), ["a", "b"]);
  commit("2026-07-12", first, at("2026-07-19"));

  // Same day re-queried: both already delivered, plus one genuinely new.
  const second = [...first, txn("c", "2026-07-19")];
  assert.deepEqual(unseen(loadWatermark(), second).map((t) => t.nodeId), ["c"]);
});

test("a pending that settles late is still delivered exactly once", () => {
  // Day 1: only the settled charge is visible.
  commit("2026-07-12", [txn("settled", "2026-07-17")], at("2026-07-19"));

  // Day 2: RM finally surfaces a pending from the 16th, BACKDATED before the
  // newest id we already saw. A forward-only date cursor would miss this.
  const withLate = [txn("late", "2026-07-16"), txn("settled", "2026-07-17")];
  const fresh = unseen(loadWatermark(), withLate);
  assert.deepEqual(fresh.map((t) => t.nodeId), ["late"]);

  // And once delivered, it does not repeat.
  commit("2026-07-13", fresh, at("2026-07-20"));
  assert.deepEqual(unseen(loadWatermark(), withLate).map((t) => t.nodeId), []);
});

test("seen-set is pruned below the window floor so the file stays bounded", () => {
  const old = txn("ancient", "2026-05-01");
  const recent = txn("recent", "2026-07-18");
  const row = commit("2026-07-12", [old, recent], at("2026-07-19"));
  // 'ancient' is outside any window a future query can reach, so keeping it
  // would only grow the file forever.
  assert.deepEqual(row.seen.map((e) => e.id), ["recent"]);
});

test("commit is idempotent on ids - no duplicate seen entries", () => {
  commit("2026-07-12", [txn("a", "2026-07-18")], at("2026-07-19"));
  const row = commit("2026-07-12", [txn("a", "2026-07-18")], at("2026-07-19"));
  assert.equal(row.seen.filter((e) => e.id === "a").length, 1);
});

test("reset re-opens the last window", () => {
  commit("2026-07-12", [txn("a", "2026-07-18")], at("2026-07-19"));
  resetWatermark();
  const row = loadWatermark();
  assert.equal(row.lastCheckedAt, null);
  assert.deepEqual(unseen(row, [txn("a", "2026-07-18")]).map((t) => t.nodeId), ["a"]);
});

test("a corrupt state file degrades to 'never checked' rather than throwing", () => {
  writeFileSync(join(process.env.ROCKETMONEY_STATE_DIR!, "txn-watermark.json"), "{not json");
  assert.deepEqual(loadWatermark(), { lastCheckedAt: null, lastSince: null, seen: [] });
});

// ── per-slug feeds ────────────────────────────────────────────────

test("slugged feeds are independent: each sees the same transaction once", () => {
  const t = [txn("a", "2026-07-18"), txn("b", "2026-07-18")];
  // Default feed consumes both.
  commit("2026-07-12", t, at("2026-07-19"));
  assert.deepEqual(unseen(loadWatermark(), t).map((x) => x.nodeId), []);
  // The groceries feed has never seen them - consuming on one feed must not
  // starve another, which is the entire point of the slug.
  assert.deepEqual(unseen(loadWatermark("groceries"), t).map((x) => x.nodeId), ["a", "b"]);
  commit("2026-07-12", t, at("2026-07-19"), "groceries");
  assert.deepEqual(unseen(loadWatermark("groceries"), t).map((x) => x.nodeId), []);
});

test("resetting one feed leaves the others untouched", () => {
  const t = [txn("a", "2026-07-18")];
  commit("2026-07-12", t, at("2026-07-19"));
  commit("2026-07-12", t, at("2026-07-19"), "groceries");
  resetWatermark("groceries");
  assert.deepEqual(unseen(loadWatermark("groceries"), t).map((x) => x.nodeId), ["a"]);
  assert.deepEqual(unseen(loadWatermark(), t).map((x) => x.nodeId), []); // default intact
});

test("each feed keeps its own last-checked anchor", () => {
  commit("2026-06-01", [], at("2026-06-08"));                 // default: stale
  commit("2026-07-12", [], at("2026-07-19"), "groceries");    // groceries: fresh
  assert.equal(nextSince(loadWatermark(), at("2026-07-19")), "2026-06-01");
  assert.equal(nextSince(loadWatermark("groceries"), at("2026-07-19")), "2026-07-12");
});

test("slug validation refuses traversal, reserved names, and bad shapes", () => {
  for (const ok of ["groceries", "g", "a-b-c", "feed2"]) assert.equal(validSlug(ok), true, ok);
  for (const bad of ["reset", "../etc", "a/b", "A", "-lead", "", "x".repeat(33), "a_b", "a.b"]) {
    assert.equal(validSlug(bad), false, bad);
  }
});
