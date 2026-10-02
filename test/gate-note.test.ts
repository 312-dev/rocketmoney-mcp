import { test } from "node:test";
import assert from "node:assert/strict";
import { gateNoteDecision } from "../src/api.js";

test("a gate note fills an empty row", () => {
  assert.deepEqual(gateNoteDecision("", "Gate: Essentials, work parking"), { ok: true });
  assert.deepEqual(gateNoteDecision(null, "Gate: Essentials, work parking"), { ok: true });
});

test("a gate note may replace an older gate note", () => {
  assert.deepEqual(gateNoteDecision("Gate: Discretionary", "Gate: Essentials, appeal granted"), { ok: true });
});

test("a note a person wrote is never replaced", () => {
  const d = gateNoteDecision("work parking", "Gate: Discretionary");
  assert.equal(d.ok, false);
  assert.equal(!d.ok && d.status, 409);
});

test("only one-line gate notes may be written", () => {
  for (const note of ["work parking", "Gate: a\nb", "Gate: " + "x".repeat(300)]) {
    const d = gateNoteDecision("", note);
    assert.equal(!d.ok && d.status, 400, note.slice(0, 20));
  }
});
