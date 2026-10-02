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
            hint: "Re-auth at this server's /auth page",
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
                hint: "Re-auth at this server's /auth page",
            });
            return;
        }
        console.error("[api] transactions error:", err);
        res.status(502).json({ ok: false, error: "upstream error", detail: String(err) });
    }
}
/**
 * GET /api/budget
 *
 * One read for a caller deciding whether a new recurring charge fits: the
 * budgets, every recurring merchant Rocket Money knows, the next 28 days of
 * bills, this month's spending by category, and the manually-tracked assets
 * (the Marcus balances that marcus-rm-sync mirrors in hourly). Same shapes the MCP tools
 * return, so a human and a script are reading the same numbers. Same bearer
 * guard as the transactions feed, for the same unattended callers.
 */
export async function budgetSnapshot(req, res) {
    if (!authorized(req)) {
        logHit(req, "-> 401");
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
    }
    // Five independent reads. Rocket Money rotates its persisted-query hashes
    // one at a time, so a single stale hash must cost one section, not the
    // whole snapshot; whatever failed is named under `errors` instead.
    const reads = {
        budgets: () => rm.getBudgets().then(fmt.shapeBudgets),
        // activeOnly: this snapshot answers "does another charge fit", so the rows
        // that stopped charging are noise here. The subscriptions MCP tool keeps
        // them, because auditing the list is the opposite question.
        recurring: () => rm.getRecurring().then((d) => fmt.shapeRecurring(d, { activeOnly: true })),
        upcoming: () => rm.getUpcoming(28).then(fmt.shapeUpcoming),
        spending: () => rm.getSpending().then(fmt.shapeSpending),
        assets: () => rm.getAssets().then((xs) => xs.map((a) => ({ name: a.name, value: Math.round(a.valueCents) / 100, type: a.assetType }))),
    };
    const body = { ok: true, as_of: new Date().toISOString() };
    const errors = {};
    let authFailed = false;
    await Promise.all(Object.entries(reads).map(async ([key, read]) => {
        try {
            body[key] = await read();
        }
        catch (err) {
            if (err instanceof RMAuthError)
                authFailed = true;
            errors[key] = err.message;
        }
    }));
    if (authFailed) {
        logHit(req, "-> 503 (session inactive)");
        res.status(503).json({ ok: false, error: "rocket money session inactive", session: sessionStatus() });
        return;
    }
    if (Object.keys(errors).length === Object.keys(reads).length) {
        logHit(req, `-> 500 (${Object.values(errors).join("; ")})`);
        res.status(500).json({ ok: false, error: "every read failed", errors });
        return;
    }
    if (Object.keys(errors).length)
        body.errors = errors;
    logHit(req, `-> 200${Object.keys(errors).length ? ` (partial: ${Object.keys(errors).join(",")})` : ""}`);
    res.status(200).json(body);
}
// ── Token-guarded write: the card gate's verdict on one transaction ─────
//
// The only write this API offers, and it is fenced on purpose. The bearer
// token lives on lockbox for unattended timers; if it leaks, the worst it can
// do here is write a line starting "Gate:" into a note nobody has written.
// A note a person typed is the stated purpose the card gate judges by, so it
// is never replaced, and nothing else about a transaction is reachable.
/** The prefix that marks a note as the card gate's own. */
export const GATE_NOTE_PREFIX = "Gate: ";
export const GATE_NOTE_MAX = 200;
/**
 * Whether a gate note may be written over what the row holds now.
 * Pure, so the policy is tested without Rocket Money.
 */
export function gateNoteDecision(current, note) {
    if (!note.startsWith(GATE_NOTE_PREFIX) || note.length > GATE_NOTE_MAX || note.includes("\n")) {
        return { ok: false, status: 400, error: `note must be one line starting "${GATE_NOTE_PREFIX}", at most ${GATE_NOTE_MAX} characters` };
    }
    const existing = (current ?? "").trim();
    if (existing && !existing.startsWith(GATE_NOTE_PREFIX.trim())) {
        return { ok: false, status: 409, error: "the transaction carries a note a person wrote, which is never replaced" };
    }
    return { ok: true };
}
/**
 * POST /api/gate-note/:id   body {"note": "Gate: ..."}
 *
 * The row must be inside the same lookback window the feed reads, which is
 * also how its current note is learned before deciding.
 */
export async function gateNote(req, res) {
    if (!authorized(req)) {
        logHit(req, "-> 401");
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
    }
    if (/^(1|true|yes)$/i.test(process.env.ROCKETMONEY_READ_ONLY ?? "")) {
        logHit(req, "-> 403 (read-only)");
        res.status(403).json({ ok: false, error: "this server is read-only" });
        return;
    }
    const id = String(req.params.id ?? "");
    const note = typeof req.body?.note === "string" ? req.body.note : "";
    const session = sessionStatus();
    if (session.status !== "live") {
        logHit(req, `-> 503 (session ${session.status})`);
        res.status(503).json({ ok: false, error: "rocketmoney session not active", session: session.status });
        return;
    }
    try {
        const found = await rm.searchTransactions(null, lookbackSince(new Date()));
        const row = found.find((t) => t.nodeId === id);
        if (!row) {
            logHit(req, "-> 404");
            res.status(404).json({ ok: false, error: `no transaction with that id in the last ${LOOKBACK_DAYS} days` });
            return;
        }
        const decision = gateNoteDecision(row.note, note);
        if (!decision.ok) {
            logHit(req, `-> ${decision.status}`);
            res.status(decision.status).json({ ok: false, error: decision.error });
            return;
        }
        if ((row.note ?? "").trim() === note.trim()) {
            logHit(req, "-> 200 (unchanged)");
            res.json({ ok: true, id, note, changed: false });
            return;
        }
        const saved = await rm.setTransactionNote(id, note);
        logHit(req, "-> 200 (written)");
        res.json({ ok: true, id, note: saved, changed: true });
    }
    catch (err) {
        if (err instanceof RMAuthError) {
            logHit(req, "-> 503 (RMAuthError)");
            res.status(503).json({ ok: false, error: "rocketmoney session rejected", detail: err.message });
            return;
        }
        console.error("[api] gate-note error:", err);
        res.status(502).json({ ok: false, error: "upstream error", detail: String(err) });
    }
}
