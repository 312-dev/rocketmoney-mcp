// node:test reporter for tdd-guard (the Claude Code plugin that blocks edits unless it can
// see test results). tdd-guard ships reporters for vitest, jest and pytest, not node:test,
// so this writes the same file they do: <root>/.claude/tdd-guard/data/test.json, in its
// TestResultSchema ({testModules: [{moduleId, tests: [{name, fullName, state, errors}]}]}).
//
// <root> is the Claude session's directory, which is either this repo or ~/coding/mcp. So
// it writes to every ancestor of the working directory that has .claude/tdd-guard/ (none
// in CI, where it does nothing), or to TDD_GUARD_PROJECT_ROOT if that's set.
// Used by `npm test` alongside the normal spec reporter.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

function roots() {
  if (process.env.TDD_GUARD_PROJECT_ROOT) return [process.env.TDD_GUARD_PROJECT_ROOT];
  const out = [];
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".claude", "tdd-guard"))) out.push(dir);
    if (dirname(dir) === dir) return out;
  }
}

const error = (err) => {
  const cause = err?.cause ?? err;
  return { message: String(cause?.message ?? cause ?? err), ...(cause?.stack ? { stack: String(cause.stack) } : {}) };
};

export default async function* tddGuardReporter(source) {
  const modules = new Map();
  const add = (data, state) => {
    if (data.details?.type === "suite") return; // its tests are reported one by one
    const moduleId = data.file ? resolve(data.file) : "unknown";
    if (!modules.has(moduleId)) modules.set(moduleId, []);
    const test = { name: data.name, fullName: `${relative(process.cwd(), moduleId)} > ${data.name}`, state };
    if (state === "failed") test.errors = [error(data.details?.error)];
    modules.get(moduleId).push(test);
  };
  const stderr = new Map();
  for await (const event of source) {
    if (event.type === "test:pass") add(event.data, event.data.skip || event.data.todo ? "skipped" : "passed");
    else if (event.type === "test:fail") add(event.data, "failed");
    else if (event.type === "test:stderr" && event.data.file) {
      const file = resolve(event.data.file); // relative here, absolute on test:fail
      stderr.set(file, (stderr.get(file) ?? "") + event.data.message);
    }
  }
  // A file that fails to load reports only "test failed"; the real error went to its stderr.
  for (const [file, tests] of modules) {
    for (const t of tests) if (t.state === "failed" && resolve(t.name) === file && stderr.get(file)) t.errors = [{ message: stderr.get(file).trim().slice(-4000) }];
  }
  const testModules = [...modules].map(([moduleId, tests]) => ({ moduleId, tests }));
  const failed = testModules.some((m) => m.tests.some((t) => t.state === "failed"));
  const json = JSON.stringify({ testModules, unhandledErrors: [], reason: failed ? "failed" : "passed" }, null, 2);
  for (const root of roots()) {
    const dir = join(root, ".claude", "tdd-guard", "data");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "test.json"), json);
  }
  yield ""; // nothing for the terminal: the spec reporter prints the results
}
