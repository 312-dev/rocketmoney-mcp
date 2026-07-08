import {
  RMAuthError,
  type RMTransaction,
  categoryNodeId,
  searchTransactions,
  setTransactionCategory,
  setTransactionNote,
} from "../rm/client.js";
import { categorizeAmazonItem } from "./categorize.js";
import { type AmazonOrderRecord, fetchAmazonOrdersSince, isAmazonCharge } from "./email.js";
import { readJson, writeJson } from "./state.js";

// Match windows mirror the grizbot Amazon matcher: amount within $0.50 (tax
// rounding) and date within 5 days (ship-vs-post lag).
const AMOUNT_TOLERANCE = 0.5;
const DATE_TOLERANCE_DAYS = 5;

// Idempotency: RM transaction nodeId -> what we last wrote. Skips re-writing
// unchanged rows so re-runs (and the scheduler) never double-touch the ledger.
const SYNCED_FILE = "amazon-synced.json";
type SyncedEntry = { note: string; category: string; syncedAt: string };
type SyncedMap = Record<string, SyncedEntry>;

export interface SyncChange {
  name: string;
  note: string;
  category: string;
  amount: string;
  date: string;
}

export interface SyncSummary {
  since: string;
  dryRun: boolean;
  scanned: number; // RM Amazon transactions in window
  matched: number; // matched to an order email
  updated: number; // written (or would-be, in dry run)
  skipped: number; // already synced, unchanged
  unmatched: number; // no order email found
  errors: string[];
  changes: SyncChange[];
}

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

/** Closest-date order whose total matches the transaction amount within tolerance. */
function matchOrder(txn: RMTransaction, orders: AmazonOrderRecord[]): AmazonOrderRecord | null {
  const dollars = Math.abs(txn.amountCents) / 100;
  let best: AmazonOrderRecord | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const order of orders) {
    if (order.orderTotal === null) continue;
    if (Math.abs(order.orderTotal - dollars) >= AMOUNT_TOLERANCE) continue;
    const diff = daysBetween(txn.date, order.date);
    if (diff > DATE_TOLERANCE_DAYS) continue;
    if (diff < bestDiff) {
      best = order;
      bestDiff = diff;
    }
  }
  return best;
}

/** YYYY-MM-DD `lookbackDays` before now (UTC). */
export function sinceFromLookback(lookbackDays: number): string {
  return new Date(Date.now() - lookbackDays * 86_400_000).toISOString().split("T")[0];
}

/**
 * Enrich Amazon transactions in Rocket Money on/after `since` (YYYY-MM-DD): set
 * the note to the real item name and the category to the best-fit RM category.
 * Idempotent. When `dryRun` is true, computes changes but writes nothing.
 * Throws RMAuthError (session dead) so callers can surface a re-auth hint.
 */
export async function syncAmazonSince(since: string, dryRun: boolean): Promise<SyncSummary> {
  const summary: SyncSummary = {
    since,
    dryRun,
    scanned: 0,
    matched: 0,
    updated: 0,
    skipped: 0,
    unmatched: 0,
    errors: [],
    changes: [],
  };

  const [rawTxns, orders] = await Promise.all([
    searchTransactions("Amazon", since),
    fetchAmazonOrdersSince(new Date(`${since}T00:00:00Z`).toISOString()),
  ]);
  // Guard: only touch rows whose merchant actually looks like Amazon, so a loose
  // amount match can never rewrite an unrelated transaction.
  const txns = rawTxns.filter((t) => isAmazonCharge(t.name));
  summary.scanned = txns.length;

  const synced = readJson<SyncedMap>(SYNCED_FILE, {});

  for (const txn of txns) {
    const order = matchOrder(txn, orders);
    if (!order) {
      summary.unmatched++;
      continue;
    }
    summary.matched++;

    const note = order.itemName;
    const cat = await categorizeAmazonItem(order.itemName);
    const amount = `$${(Math.abs(txn.amountCents) / 100).toFixed(2)}`;

    const prior = synced[txn.nodeId];
    if (prior && prior.note === note && prior.category === cat.label) {
      summary.skipped++;
      continue;
    }

    summary.changes.push({ name: txn.name, note, category: cat.label, amount, date: txn.date });

    if (dryRun) {
      summary.updated++;
      continue;
    }

    try {
      await setTransactionNote(txn.nodeId, note);
      await setTransactionCategory(txn.nodeId, categoryNodeId(cat.id));
    } catch (err) {
      if (err instanceof RMAuthError) throw err; // abort whole run - session dead
      summary.errors.push(`${note}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    synced[txn.nodeId] = { note, category: cat.label, syncedAt: new Date().toISOString() };
    writeJson(SYNCED_FILE, synced); // persist after each write for crash-safety
    summary.updated++;
  }

  return summary;
}
