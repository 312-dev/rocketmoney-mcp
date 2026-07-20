import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ymd, addDays } from "./windows.js";
import type { RMTransaction } from "./client.js";

// ── "Transactions since last check" watermark ──────────────────────
//
// A naive cursor would just remember the newest date we returned and pass it as
// `gteDate` next time. That is wrong for Rocket Money in two directions:
//
//   1. RM transactions are DATE-only (YYYY-MM-DD), not timestamps. Several
//      transactions share a date, so a date cursor can only be "on/after" -
//      it either re-emits the whole last day or (with a >) drops its stragglers.
//   2. Pending charges SETTLE LATE. A card swipe shows up days later, backdated
//      to the swipe date, and its amount/name can change when it settles. A
//      forward-only date cursor never looks back far enough to see it.
//
// So we do NOT dedupe by date. We re-query a LOOKBACK window on every call and
// dedupe by transaction id against a set of ids we have already emitted. The
// window is anchored on the LAST CHECK, not on today, so a long gap between
// calls widens the query instead of silently skipping the gap.
//
// The seen-set stays bounded because we prune every id older than the window we
// would ever query again - such an id can never come back to be deduped.

/** How far back to re-scan on every call, to catch late-settling pendings. */
const LOOKBACK_DAYS = Number(process.env.ROCKETMONEY_API_LOOKBACK_DAYS ?? 7);

// Resolved lazily (not a module const) so the state dir can be swapped per
// process/test via ROCKETMONEY_STATE_DIR - same convention as session.ts.
//
// Each SLUG is an independent consumer with its own cursor, so two pollers never
// steal each other's transactions: the default feed and e.g. "groceries" each
// see every transaction exactly once. The unslugged file keeps its original name
// so the existing cursor survives this change.
function watermarkFile(slug?: string | null): string {
  const dir = process.env.ROCKETMONEY_STATE_DIR ?? "/data/rocketmoney";
  return join(dir, slug ? `txn-watermark-${slug}.json` : "txn-watermark.json");
}

/**
 * Slugs name a state FILE, so they must not be able to escape the state dir or
 * collide with the unslugged default. Lowercase alphanumeric + dashes only.
 * `reset` is reserved because POST /api/transactions/reset is the default feed's
 * reset route - a slug of that name would make the two indistinguishable.
 */
export function validSlug(slug: string): boolean {
  if (slug === "reset") return false;
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(slug);
}

export interface SeenEntry {
  id: string;
  date: string; // YYYY-MM-DD, kept so we can prune by age
}

export interface WatermarkRow {
  lastCheckedAt: string | null; // ISO timestamp of the last committed read
  lastSince: string | null; // the gteDate we queried with last time
  seen: SeenEntry[];
}

const EMPTY: WatermarkRow = { lastCheckedAt: null, lastSince: null, seen: [] };

function ensureDir(file: string): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Read the watermark, treating a missing/corrupt file as "never checked". */
export function loadWatermark(slug?: string | null): WatermarkRow {
  try {
    const row = JSON.parse(readFileSync(watermarkFile(slug), "utf8")) as Partial<WatermarkRow>;
    return {
      lastCheckedAt: row.lastCheckedAt ?? null,
      lastSince: row.lastSince ?? null,
      seen: Array.isArray(row.seen) ? row.seen : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

function writeWatermark(row: WatermarkRow, slug?: string | null): void {
  const file = watermarkFile(slug);
  ensureDir(file);
  writeFileSync(file, JSON.stringify(row, null, 2));
}

/**
 * The `gteDate` for the next RM query.
 *
 * Anchored on the last check (not on today) so that if nothing polls for a
 * month, the window stretches to cover that month rather than leaving a hole.
 * On a first-ever call there is no anchor, so we start one lookback back -
 * meaning the very first response returns roughly the last week of activity.
 */
export function nextSince(row: WatermarkRow, ref = new Date()): string {
  const anchor = row.lastCheckedAt ? new Date(row.lastCheckedAt) : ref;
  // A clock skew / bad persisted value must not push the window into the future.
  const safeAnchor = Number.isNaN(anchor.getTime()) || anchor > ref ? ref : anchor;
  return ymd(addDays(safeAnchor, -LOOKBACK_DAYS));
}

/** Drop everything we have already handed out; what's left is genuinely new. */
export function unseen(row: WatermarkRow, txns: RMTransaction[]): RMTransaction[] {
  const seenIds = new Set(row.seen.map((e) => e.id));
  return txns.filter((t) => !seenIds.has(t.nodeId));
}

/**
 * Mark `emitted` as delivered and advance the cursor.
 *
 * `since` is the window we just queried: any id dated before it is unreachable
 * by future queries, so keeping it in the seen-set would only grow the file.
 * Callers commit ONLY after the response is built (see the api handler), which
 * is what makes this at-most-once - a crash before commit re-delivers instead
 * of skipping.
 */
export function commit(
  since: string,
  emitted: RMTransaction[],
  ref = new Date(),
  slug?: string | null,
): WatermarkRow {
  const prev = loadWatermark(slug);
  const merged = [...prev.seen, ...emitted.map((t) => ({ id: t.nodeId, date: t.date }))];

  // Prune below the next window's floor, not this one's: the next call anchors
  // on the timestamp we are about to write, so that is the oldest date any
  // future query can reach.
  const floor = ymd(addDays(ref, -LOOKBACK_DAYS - 1));
  const byId = new Map<string, SeenEntry>();
  for (const e of merged) if (e.date >= floor) byId.set(e.id, e);

  const row: WatermarkRow = {
    lastCheckedAt: ref.toISOString(),
    lastSince: since,
    seen: [...byId.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
  writeWatermark(row, slug);
  return row;
}

/** Reset to "never checked" - the next call re-emits the last lookback window. */
export function resetWatermark(slug?: string | null): void {
  writeWatermark({ ...EMPTY }, slug);
}
