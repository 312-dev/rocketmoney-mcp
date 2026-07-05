import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./mcp.js";
import { renderAuthPage, submitAuth } from "./auth-page.js";
import { refreshAuthToken } from "./rm/client.js";
import { sessionStatus } from "./rm/session.js";

const PORT = Number(process.env.PORT ?? 8080);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Health ─────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ── Browser auth page (served on rocketmoney-auth.graysons.network) ─
app.get("/", renderAuthPage);
app.get("/auth", renderAuthPage);
app.post("/auth/submit", submitAuth);

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
  } catch (err) {
    console.error("[mcp] request error:", err);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  }
});

const methodNotAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// ── Keepalive ──────────────────────────────────────────────────────
// RM's cookie rolls ~every 3h48m and there's no offline refresh token, so ping
// RefreshAuthToken periodically to keep a live session warm until Auth0's
// absolute cap kills it. Harmless when there's no session (skips quietly).
const KEEPALIVE_MS = Number(process.env.ROCKETMONEY_KEEPALIVE_MS ?? 2 * 60 * 60 * 1000); // 2h
async function keepalive(): Promise<void> {
  if (sessionStatus().status !== "live") return;
  try {
    await refreshAuthToken();
    console.log("[keepalive] ok");
  } catch (err) {
    console.warn("[keepalive] failed:", String(err));
  }
}
setInterval(keepalive, KEEPALIVE_MS).unref();

app.listen(PORT, () => {
  console.log(`[rocketmoney-mcp] listening on :${PORT}  (POST /mcp, GET /auth)`);
});
