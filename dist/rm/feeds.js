import { ymd, addDays } from "./windows.js";
// ── Stateless transaction feeds ────────────────────────────────────
//
// Every read returns a FIXED lookback window ending today, unfiltered: the same
// call always yields the same "last N days" of transactions. There is no cursor
// and no dedupe - a caller that only wants "what's new" diffs on its own side.
//
// This replaced an at-most-once watermark cursor. The tradeoff is deliberate:
// idempotence (safe to re-poll, nothing to advance, nothing to reset) in
// exchange for giving up server-side delta state. The response carries a
// `last_scanned` timestamp in place of the cursor the caller used to rely on.
//
// The window still reaches back a full week by default because Rocket Money
// transactions are DATE-only and pendings settle late (a swipe surfaces days
// later, backdated to the swipe date), so a shorter window would silently drop
// late-arriving charges.
/** How many days back each read scans. Env-overridable; one week by default. */
export const LOOKBACK_DAYS = Number(process.env.ROCKETMONEY_API_LOOKBACK_DAYS ?? 7);
/** The gteDate for a read: LOOKBACK_DAYS before `ref` (UTC, date-only). */
export function lookbackSince(ref = new Date()) {
    return ymd(addDays(ref, -LOOKBACK_DAYS));
}
/**
 * Slugs name a per-consumer feed. Feeds no longer own cursor state, but a slug
 * is still echoed back (and may name a file again in future), so keep the same
 * strict shape: lowercase alphanumeric + dashes, max 32 chars. `reset` stays
 * reserved so a leftover caller hitting the old .../reset path is rejected as a
 * bad slug rather than silently served a feed literally named "reset".
 */
export function validSlug(slug) {
    if (slug === "reset")
        return false;
    return /^[a-z0-9][a-z0-9-]{0,31}$/.test(slug);
}
