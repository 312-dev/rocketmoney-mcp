import { test } from "node:test";
import assert from "node:assert/strict";
import { monthStart, monthWindows, ymd, addDays } from "../src/rm/windows.js";

// Anchor: these are the EXACT variable values Rocket Money's web app sent on
// 2026-07-05 (captured in the HAR). If our helper drifts from RM's grammar,
// these assertions break.
const REF = new Date("2026-07-05T14:00:00Z");

test("monthWindows matches Rocket Money's captured date grammar", () => {
  const w = monthWindows(REF);
  assert.equal(w.now, "2026-07-05");
  assert.equal(w.currentMonthStart, "2026-07-01");
  assert.equal(w.nextMonthStart, "2026-08-01");
  assert.equal(w.previousMonthStart, "2026-06-01");
  assert.equal(w.sixMonthsAgo, "2026-01-01");
  assert.equal(w.lastMonthEnd, "2026-06-30"); // last day of June
});

test("monthStart handles year rollover", () => {
  const jan = new Date("2026-01-15T00:00:00Z");
  assert.equal(ymd(monthStart(jan, -1)), "2025-12-01");
  assert.equal(ymd(monthStart(jan, -6)), "2025-07-01");
});

test("addDays crosses month boundaries", () => {
  assert.equal(ymd(addDays(new Date("2026-07-05T00:00:00Z"), 28)), "2026-08-02");
});

test("ymd is UTC date-only", () => {
  assert.equal(ymd(new Date("2026-03-09T23:59:59Z")), "2026-03-09");
});
