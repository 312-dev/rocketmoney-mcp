import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./mcp.js";
import { renderAuthPage, submitAuth, triggerLogin, postOtp, smsWebhook } from "./auth-page.js";
import { refreshAuthToken } from "./rm/client.js";
import { sessionStatus } from "./rm/session.js";
import { attemptLogin, autoLoginConfigured } from "./rm/login.js";
import { newTransactions, budgetSnapshot } from "./api.js";
const PORT = Number(process.env.PORT ?? 8080);
const app = express();
// ── Local-only guard ───────────────────────────────────────────────
// This build has no front door (upstream assumes Cloudflare Access), so it
// listens on loopback only and rejects requests a web page could forge: a Host
// other than this machine (DNS rebinding) or a cross-site Origin (CSRF).
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
app.use((req, res, next) => {
    const origin = req.header("origin");
    const host = req.header("host") ?? "";
    if (!LOCAL_HOSTS.has(host) || (origin && !LOCAL_HOSTS.has(origin.replace(/^http:\/\//, "")))) {
        return void res.status(403).json({ ok: false, error: "local requests only" });
    }
    next();
});
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
// Some SMS-forwarder apps POST the raw message as text/plain - capture it as a string.
app.use(express.text({ type: ["text/plain"], limit: "64kb" }));
// ── Health ─────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
// ── Browser auth page ─────────────────────────────────────────────
app.get("/", renderAuthPage);
app.get("/auth", renderAuthPage);
app.post("/auth/submit", submitAuth);
app.post("/auth/login", triggerLogin); // trigger headless auto-login
app.post("/auth/otp", postOtp); // feed an SMS code to a parked login run
app.post("/auth/sms", smsWebhook); // phone SMS-forwarder posts the RM code here (shared-secret guarded)
// ── JSON API for the browser extension ─────────────────────────────
// Removed in this local build: /auth/ingest and /auth/status were open to any
// website (CORS *), and the session is pasted at /auth instead.
// ── Token-guarded JSON API (last N days of transactions) ───────────
// Auth is the ROCKETMONEY_API_TOKEN bearer/?token= check inside the handler,
// NOT Cloudflare Access - this is meant for unattended script callers.
// Stateless snapshot: every read returns the same lookback window. Slugs still
// name independent feeds (they set the `feed` label) but carry no cursor state,
// so there is nothing to advance and no reset route. The bare route is declared
// first; the slug route follows so a bare hit is not read as an empty slug.
app.get("/api/transactions", newTransactions);
app.get("/api/transactions/:slug", newTransactions);
// Budgets, recurring merchants, upcoming bills and spending in one read, for
// the card gate on lockbox deciding whether a new Essentials charge fits.
app.get("/api/budget", budgetSnapshot);
// ── MCP endpoint ──────────────────────────────────────────────────
// Stateless streamable HTTP: a fresh server+transport per request, torn down on
// socket close, so the process holds no per-connection state and Fly can recycle
// it freely. The rotating RM cookie lives on the volume, not in the transport.
app.post("/mcp", async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
        transport.close();
        server.close();
    });
    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    }
    catch (err) {
        console.error("[mcp] request error:", err);
        if (!res.headersSent)
            res.status(500).json({ error: "internal error" });
    }
});
const methodNotAllowed = (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);
// ── Keepalive ──────────────────────────────────────────────────────
// RM's cookie rolls ~every 3h48m and there's no offline refresh token, so ping
// RefreshAuthToken periodically to keep a live session warm until Auth0's
// absolute cap kills it. Harmless when there's no session (skips quietly).
const KEEPALIVE_MS = Number(process.env.ROCKETMONEY_KEEPALIVE_MS ?? 2 * 60 * 60 * 1000); // 2h
async function keepalive() {
    // Dead/missing session: fall back to a headless re-login (rate-limited + backed
    // off inside attemptLogin, so this can safely run every keepalive tick). A cold
    // login may park on the SMS challenge - the user finishes it from /auth.
    if (sessionStatus().status !== "live") {
        if (autoLoginConfigured()) {
            const r = await attemptLogin("keepalive: session not live");
            if (!r.ok && !r.error?.startsWith("rate-limited"))
                console.warn("[keepalive] auto-login:", r.error);
        }
        return;
    }
    try {
        await refreshAuthToken();
        console.log("[keepalive] ok");
    }
    catch (err) {
        console.warn("[keepalive] failed:", String(err));
        // A refresh that fails on auth means the session just died; let auto-login
        // (rate-limited) take over on the next tick rather than spinning here.
    }
}
setInterval(keepalive, KEEPALIVE_MS).unref();
app.listen(PORT, "127.0.0.1", () => {
    console.log(`[rocketmoney-mcp] listening on 127.0.0.1:${PORT}  (POST /mcp, GET /auth)`);
});
