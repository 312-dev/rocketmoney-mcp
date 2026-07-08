import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
// ── Rotating Rocket Money session ──────────────────────────────────
//
// Rocket Money's web session is a SHORT-LIVED (~3h48m) rolling cookie. Every
// authenticated response re-issues `tb.auth0.sid` (and AWS ALB stickiness
// cookies) via Set-Cookie. We keep a cookie jar, update it from every response,
// and persist it so rotation survives across requests AND across gateway
// redeploys (the file lives on the mounted Fly volume, not the ephemeral fs).
//
// There is NO offline refresh token. When Auth0's absolute session cap is hit
// the session dies and must be re-seeded with a fresh cookie pasted into the
// /auth page. `RefreshAuthToken` (see client.ts) keeps it warm until then.
// Resolved lazily (not a module const) so the state dir can be swapped per
// process/test via ROCKETMONEY_STATE_DIR without re-importing the module.
function sessionFile() {
    return join(process.env.ROCKETMONEY_STATE_DIR ?? "/data/rocketmoney", "session.json");
}
function ensureDir(file) {
    const dir = dirname(file);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
}
function readRow() {
    try {
        return JSON.parse(readFileSync(sessionFile(), "utf8"));
    }
    catch {
        return null;
    }
}
function writeRow(row) {
    const file = sessionFile();
    ensureDir(file);
    writeFileSync(file, JSON.stringify(row, null, 2));
}
/** Parse a `name=value; name2=value2` Cookie header string into a jar. */
export function parseCookieHeader(header) {
    const jar = new Map();
    for (const part of header.split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1)
            continue;
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (name)
            jar.set(name, value);
    }
    return jar;
}
/** Serialize a jar back into a Cookie request-header string. */
export function serializeJar(jar) {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
/**
 * Apply Set-Cookie response headers to the jar (rotation). We only care about
 * the cookie name/value (the first `k=v` of each Set-Cookie), not attributes,
 * and we skip deletions so a logout-style Set-Cookie can't wipe live auth.
 */
export function applySetCookies(jar, setCookies) {
    for (const sc of setCookies) {
        const firstPair = sc.split(";")[0];
        const eq = firstPair.indexOf("=");
        if (eq === -1)
            continue;
        const name = firstPair.slice(0, eq).trim();
        const value = firstPair.slice(eq + 1).trim();
        if (name && value && value.toLowerCase() !== "deleted")
            jar.set(name, value);
    }
}
/**
 * Normalize whatever the user (or the browser extension) hands us into a Cookie
 * header string. Accepts three shapes, most-to-least structured:
 *   1. a full Cookie header:  `tb.auth0.sid=abc; AWSALB=xyz`
 *   2. just the pair:         `tb.auth0.sid=abc`
 *   3. JUST THE VALUE:        `abc`   <- no k=v required
 * If the input doesn't already carry a tb.auth0.sid pair, we treat the entire
 * trimmed string as the bare tb.auth0.sid value and wrap it.
 */
export function normalizeCookieInput(raw) {
    const s = raw.trim();
    if (!s)
        return s;
    return /(^|;\s*)tb\.auth0\.sid=/.test(s) ? s : `tb.auth0.sid=${s}`;
}
/**
 * Seed a brand-new session from a cookie the user pasted into /auth or the
 * extension pushed to /auth/ingest. A freshly-exported cookie ALWAYS replaces
 * stale persisted state. Returns an error message if the value is unusable, or
 * null on success.
 */
export function seedSession(rawCookie) {
    const jar = parseCookieHeader(normalizeCookieInput(rawCookie));
    if (!jar.get("tb.auth0.sid")) {
        return "No session value provided. Paste the tb.auth0.sid value (just the value is fine), or the whole Cookie header, from a logged-in app.rocketmoney.com request.";
    }
    writeRow({
        cookie: serializeJar(jar),
        status: "live",
        seededAt: new Date().toISOString(),
        refreshedAt: new Date().toISOString(),
        lastError: null,
    });
    return null;
}
/**
 * Load the live cookie jar. Every request reads this so it picks up the
 * previous request's rotated cookie. Returns null if missing or dead.
 */
export function loadSession() {
    const row = readRow();
    if (row && row.status === "live" && row.cookie)
        return parseCookieHeader(row.cookie);
    return null;
}
/** Persist the rotated jar after a successful authenticated request. */
export function saveSession(jar) {
    const prev = readRow();
    writeRow({
        cookie: serializeJar(jar),
        status: "live",
        seededAt: prev?.seededAt,
        refreshedAt: new Date().toISOString(),
        lastError: null,
    });
}
/** Mark the session dead so tools report "re-auth needed" until it's re-seeded. */
export function markSessionDead(error) {
    const prev = readRow();
    writeRow({
        cookie: prev?.cookie ?? "",
        status: "dead",
        seededAt: prev?.seededAt,
        refreshedAt: prev?.refreshedAt,
        lastError: error,
    });
}
export function sessionStatus() {
    const row = readRow();
    if (!row)
        return { status: "missing" };
    return {
        status: row.status,
        seededAt: row.seededAt,
        refreshedAt: row.refreshedAt,
        lastError: row.lastError,
    };
}
