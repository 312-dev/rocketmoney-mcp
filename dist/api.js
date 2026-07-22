import { createHash, timingSafeEqual } from "node:crypto";
import { RMAuthError } from "./rm/client.js";
import * as rm from "./rm/client.js";
import * as fmt from "./rm/format.js";
import { sessionStatus } from "./rm/session.js";
import { lookbackSince, LOOKBACK_DAYS, validSlug } from "./rm/feeds.js";
// ── Token-guarded JSON API: "the last N days of transactions" ──────
//
// Sibling of /mcp, not a client of it: both call rm.searchTransactions() over
// the same persisted cookie jar. Routing a machine caller back out through the
// MCP JSON-RPC envelope would buy nothing but a round trip.
//
// The feed is STATELESS: every read returns the same fixed lookback window
// (LOOKBACK_DAYS ending today), unfiltered. There is no cursor to advance and
// nothing to reset - re-polling is idempotent. The response carries a
// `last_scanned` timestamp in place of the cursor callers used to track.
/**
 * Compare via SHA-256 digests rather than the raw strings: timingSafeEqual
 * throws on length mismatch, and digesting makes every comparison fixed-width,
 * so an attacker cannot even learn the token's LENGTH from timing or errors.
 */
function secretEqual(a, b) {
    const ha = createHash("sha256").update(a).digest();
    const hb = createHash("sha256").update(b).digest();
    return timingSafeEqual(ha, hb);
}
/**
 * Accept the token from either `Authorization: Bearer <t>` or `?token=<t>`.
 *
 * The query-param form is there for callers that cannot set headers, but it is
 * the weaker path: query strings land in Cloudflare's access logs, cloudflared's
 * logs, and shell history, whereas headers do not. Prefer the header when the
 * client supports it.
 *
 * Fails CLOSED when ROCKETMONEY_API_TOKEN is unset, so a missing secret makes
 * the endpoint unreachable rather than public.
 */
function authorized(req) {
    const want = process.env.ROCKETMONEY_API_TOKEN ?? "";
    if (want.length < 16)
        return false; // unset or too weak to be a real token
    const bearer = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "")?.[1] ?? "";
    const query = typeof req.query.token === "string" ? req.query.token : "";
    const got = bearer || query;
    if (!got)
        return false;
    return secretEqual(got, want);
}
/**
 * Resolve the feed slug from the route. Each slug is an INDEPENDENT consumer with
 * its own cursor, so adding one never steals transactions from another - the
 * default feed and /groceries each see every transaction exactly once.
 *
 * Returns undefined for the unslugged default feed, or false if the slug is
 * malformed (it names a state file, so it must not escape the state dir).
 */
function feedSlug(req) {
    const raw = req.params.slug;
    if (raw === undefined)
        return undefined;
    return validSlug(raw) ? raw : false;
}
/** Log the path only - never req.originalUrl, which carries ?token=. */
function logHit(req, note) {
    console.log(`[api] ${req.method} ${req.path} ${note}`);
}
/**
 * GET /api/transactions          (default feed)
 * GET /api/transactions/:slug    (named feed, e.g. /groceries)
 *
 * Returns the last LOOKBACK_DAYS of transactions, oldest first, unfiltered.
 * Stateless: the same call always returns the same window, so re-polling is
 * idempotent. Slugs still name independent feeds but no longer carry any
 * server-side state - they only change the `feed` label on the response.
 */
export async function newTransactions(req, res) {
    if (!authorized(req)) {
        logHit(req, "-> 401");
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
    }
    const slug = feedSlug(req);
    if (slug === false) {
        logHit(req, "-> 400 (bad slug)");
        res.status(400).json({
            ok: false,
            error: "invalid feed slug",
            hint: "Lowercase letters, digits and dashes only (max 32 chars); 'reset' is reserved.",
        });
        return;
    }
    // Surface a dead session as 503 + a hint rather than an empty 200, so a poller
    // can alert instead of quietly believing there was no spending.
    const session = sessionStatus();
    if (session.status !== "live") {
        logHit(req, `-> 503 (session ${session.status})`);
        res.status(503).json({
            ok: false,
            error: "rocketmoney session not active",
            session: session.status,
            hint: "Re-auth at https://rocketmoney-auth.graysons.network/auth",
        });
        return;
    }
    const lastScanned = new Date();
    const since = lookbackSince(lastScanned);
    try {
        const found = await rm.searchTransactions(null, since);
        // Oldest first: the window reads chronologically, like a statement.
        found.sort((a, b) => (a.date === b.date ? a.nodeId.localeCompare(b.nodeId) : a.date < b.date ? -1 : 1));
        logHit(req, `-> 200 (${found.length} in last ${LOOKBACK_DAYS}d)`);
        res.json({
            // last_scanned leads the body: it is the timestamp that replaced the
            // cursor - "as of when this window was read", not a delta boundary.
            last_scanned: lastScanned.toISOString(),
            ok: true,
            feed: slug ?? "default",
            since,
            lookback_days: LOOKBACK_DAYS,
            count: found.length,
            transactions: found.map((t) => ({
                id: t.nodeId,
                date: t.date,
                amount: fmt.usd(t.amountCents),
                name: t.name,
                category: t.categoryLabel,
                note: t.note,
            })),
        });
    }
    catch (err) {
        if (err instanceof RMAuthError) {
            logHit(req, "-> 503 (RMAuthError)");
            res.status(503).json({
                ok: false,
                error: "rocketmoney session rejected",
                detail: err.message,
                hint: "Re-auth at https://rocketmoney-auth.graysons.network/auth",
            });
            return;
        }
        console.error("[api] transactions error:", err);
        res.status(502).json({ ok: false, error: "upstream error", detail: String(err) });
    }
}
