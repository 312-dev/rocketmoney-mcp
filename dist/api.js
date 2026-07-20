import { createHash, timingSafeEqual } from "node:crypto";
import { RMAuthError } from "./rm/client.js";
import * as rm from "./rm/client.js";
import * as fmt from "./rm/format.js";
import { sessionStatus } from "./rm/session.js";
import { loadWatermark, nextSince, unseen, commit, resetWatermark, validSlug } from "./rm/watermark.js";
// ── Token-guarded JSON API: "transactions since I last asked" ──────
//
// Sibling of /mcp, not a client of it: both call rm.searchTransactions() over
// the same persisted cookie jar. Routing a machine caller back out through the
// MCP JSON-RPC envelope would buy nothing but a round trip.
//
// The cursor is AT-MOST-ONCE by request: a successful response advances the
// watermark, so a consumer that crashes after receiving the body will not see
// those transactions again. Use ?peek=1 to read without advancing.
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
 * Returns every transaction not yet returned by a previous call ON THAT FEED,
 * oldest first, then advances that feed's cursor. Feeds are independent: the
 * same transaction is delivered once to each feed that asks for it.
 *
 *   ?peek=1   read without advancing the cursor (safe for testing)
 *   ?limit=N  cap the batch (the cursor still only advances over what was sent)
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
    const peek = req.query.peek === "1" || req.query.peek === "true";
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : null;
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
    const row = loadWatermark(slug);
    const since = nextSince(row);
    try {
        const found = await rm.searchTransactions(null, since);
        const fresh = unseen(row, found);
        // Oldest first: "what happened since I last looked" reads chronologically.
        fresh.sort((a, b) => (a.date === b.date ? a.nodeId.localeCompare(b.nodeId) : a.date < b.date ? -1 : 1));
        const batch = limit === null ? fresh : fresh.slice(0, limit);
        // Commit AFTER the batch is finalized and BEFORE sending, so we never
        // advance past something we failed to serialize.
        if (!peek)
            commit(since, batch, new Date(), slug);
        logHit(req, `-> 200 (${batch.length} new of ${found.length} scanned${peek ? ", peek" : ""})`);
        res.json({
            ok: true,
            feed: slug ?? "default",
            since,
            checked_at: new Date().toISOString(),
            previously_checked_at: row.lastCheckedAt,
            cursor_advanced: !peek,
            count: batch.length,
            truncated: batch.length < fresh.length,
            transactions: batch.map((t) => ({
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
/**
* POST /api/transactions/reset
 * POST /api/transactions/:slug/reset
 *
 * Clears that feed's cursor so the next GET re-emits the last lookback window. The
 * escape hatch for the at-most-once tradeoff: if a consumer dropped a batch,
 * this is how you get it back.
 */
export function resetCursor(req, res) {
    if (!authorized(req)) {
        logHit(req, "-> 401");
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
    }
    const slug = feedSlug(req);
    if (slug === false) {
        logHit(req, "-> 400 (bad slug)");
        res.status(400).json({ ok: false, error: "invalid feed slug" });
        return;
    }
    const before = loadWatermark(slug);
    resetWatermark(slug);
    logHit(req, "-> 200 (cursor reset)");
    res.json({
        ok: true,
        reset: true,
        feed: slug ?? "default",
        previously_checked_at: before.lastCheckedAt,
    });
}
