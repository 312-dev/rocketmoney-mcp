import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./mcp.js";
import { renderAuthPage, submitAuth, ingestAuth, authStatus, triggerLogin, postOtp, smsWebhook } from "./auth-page.js";
import { refreshAuthToken } from "./rm/client.js";
import { sessionStatus } from "./rm/session.js";
import { attemptLogin, autoLoginConfigured } from "./rm/login.js";
import { newTransactions, resetCursor } from "./api.js";
const PORT = Number(process.env.PORT ?? 8080);
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
// Some SMS-forwarder apps POST the raw message as text/plain - capture it as a string.
app.use(express.text({ type: ["text/plain"], limit: "64kb" }));
// ── Health ─────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
// ── Browser auth page (served on rocketmoney-auth.graysons.network) ─
app.get("/", renderAuthPage);
app.get("/auth", renderAuthPage);
app.post("/auth/submit", submitAuth);
app.post("/auth/login", triggerLogin); // trigger headless auto-login
app.post("/auth/otp", postOtp); // feed an SMS code to a parked login run
app.post("/auth/sms", smsWebhook); // phone SMS-forwarder posts the RM code here (shared-secret guarded)
// ── JSON API for the browser extension ─────────────────────────────
// CORS is permissive: the extension service worker with host_permissions does
// not trigger a preflight, but browser-context callers might. Auth is at the
// Cloudflare Access edge (service token / OTP), not here.
app.use(["/auth/ingest", "/auth/status", "/auth/sms"], (req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "content-type, x-sms-secret, cf-access-client-id, cf-access-client-secret");
    if (req.method === "OPTIONS")
        return void res.status(204).end();
    next();
});
app.get("/auth/status", authStatus);
app.post("/auth/ingest", ingestAuth);
// ── Token-guarded JSON API (transactions since last check) ─────────
// Auth is the ROCKETMONEY_API_TOKEN bearer/?token= check inside the handlers,
// NOT Cloudflare Access - this is meant for unattended script callers.
// Each slug is an independent consumer with its own cursor, so /groceries and
// the default feed both see every transaction exactly once. Slug routes are
// declared AFTER the bare ones so /api/transactions/reset stays the default
// feed's reset rather than being read as a slug named "reset".
app.get("/api/transactions", newTransactions);
app.post("/api/transactions/reset", resetCursor);
app.get("/api/transactions/:slug", newTransactions);
app.post("/api/transactions/:slug/reset", resetCursor);
// ── MCP endpoint (served on rocketmoney.graysons.network via Worker) ─
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
app.listen(PORT, () => {
    console.log(`[rocketmoney-mcp] listening on :${PORT}  (POST /mcp, GET /auth)`);
});
