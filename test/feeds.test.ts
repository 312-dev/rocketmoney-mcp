import { test } from "node:test";
import assert from "node:assert/strict";
import { lookbackSince, validSlug } from "../src/rm/feeds.js";

const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

test("lookbackSince reaches a full week back from the reference day", () => {
  // 7-day default: the window opens on the 12th for a read on the 19th.
  assert.equal(lookbackSince(at("2026-07-19")), "2026-07-12");
});

test("lookbackSince is date-only and crosses month boundaries", () => {
  assert.equal(lookbackSince(at("2026-08-03")), "2026-07-27");
});

test("lookbackSince is stateless: the same day always yields the same floor", () => {
  // No cursor, no anchor - re-reading is idempotent by construction.
  assert.equal(lookbackSince(at("2026-07-19")), lookbackSince(at("2026-07-19")));
});

test("slug validation refuses traversal, reserved names, and bad shapes", () => {
  for (const ok of ["groceries", "g", "a-b-c", "feed2"]) assert.equal(validSlug(ok), true, ok);
  for (const bad of ["reset", "../etc", "a/b", "A", "-lead", "", "x".repeat(33), "a_b", "a.b"]) {
    assert.equal(validSlug(bad), false, bad);
  }
});
