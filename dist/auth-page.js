import { seedSession, sessionStatus } from "./rm/session.js";
import { attemptLogin, submitOtp, otpPending, loginState } from "./rm/login.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The paste-a-cookie page. Served on rocketmoney-auth.graysons.network, which
// routes tunnel -> here directly (NOT through the OAuth Worker), and is gated at
// the Cloudflare edge by the single-user Access policy. So reaching this page
// already means the request is the account owner; we don't add our own password.
function page(body) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rocket Money MCP - Session</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; max-width: 640px;
         margin: 6vh auto; padding: 0 20px; }
  h1 { font-size: 20px; }
  code, pre { background: rgba(128,128,128,.15); padding: .1em .3em; border-radius: 4px; }
  ol { padding-left: 1.2em; } li { margin: .4em 0; }
  textarea { width: 100%; min-height: 90px; font: 13px monospace;
             padding: 10px; box-sizing: border-box; border-radius: 8px;
             border: 1px solid rgba(128,128,128,.4); }
  button { margin-top: 12px; padding: 10px 18px; font-size: 15px; border: 0;
           border-radius: 8px; background: #6b4dff; color: #fff; cursor: pointer; }
  .ok { color: #1a7f37; } .bad { color: #cf222e; }
  .status { padding: 10px 14px; border-radius: 8px; background: rgba(128,128,128,.12);
            margin: 16px 0; }
</style></head><body>
${body}
</body></html>`;
}
function statusBlock() {
    const s = sessionStatus();
    const label = s.status === "live"
        ? `<span class="ok">&#9679; live</span> (last refreshed ${s.refreshedAt ?? "?"})`
        : s.status === "dead"
            ? `<span class="bad">&#9679; expired</span> - re-paste below${s.lastError ? ` (${s.lastError})` : ""}`
            : `<span class="bad">&#9679; not configured</span>`;
    return `<div class="status">Current session: ${label}</div>`;
}
/**
 * Auto-login controls. Only rendered when ROCKETMONEY_AUTO_LOGIN is configured.
 * Shows a "Log in now" button, and - while a run is parked on the SMS step - an
 * OTP box to feed the texted code back to the waiting headless browser.
 */
function autoLoginBlock() {
    const st = loginState();
    if (!st.configured)
        return "";
    if (st.otpPending) {
        return `<div class="status">
  <b>Enter the SMS code</b> - Rocket Money texted a verification code. Type it here to
  finish the automated login.
  <form method="post" action="/auth/otp" style="margin-top:10px">
    <input name="code" inputmode="numeric" autocomplete="one-time-code" autofocus
           style="font:15px monospace;padding:8px;border-radius:8px;border:1px solid rgba(128,128,128,.4)">
    <button type="submit">Submit code</button>
  </form>
</div>`;
    }
    const busy = st.inFlight ? " (in progress...)" : "";
    const cool = st.cooldownMs > 0 ? ` - next auto-attempt in ${Math.ceil(st.cooldownMs / 60000)}m` : "";
    return `<div class="status">
  <b>Automated login</b> is enabled${busy}. It drives a headless browser to refresh the
  session when it dies${cool}.
  <form method="post" action="/auth/login" style="margin-top:10px">
    <button type="submit"${st.inFlight ? " disabled" : ""}>Log in now</button>
  </form>
</div>`;
}
export function renderAuthPage(_req, res) {
    res.status(200).type("html").send(page(`
<h1>Rocket Money MCP session</h1>
${statusBlock()}
${autoLoginBlock()}
<p>Rocket Money has no third-party login, so this connector reuses your own web
session. Grab the cookie and paste it here - it stays on your gateway machine and
is never sent anywhere but Rocket Money's API.</p>
<ol>
  <li>Open <a href="https://app.rocketmoney.com" target="_blank" rel="noopener">app.rocketmoney.com</a> and make sure you're logged in.</li>
  <li>Open DevTools (&#8984;&#8997;I) &rarr; <b>Application</b> &rarr; <b>Cookies</b> &rarr; <code>https://app.rocketmoney.com</code>.</li>
  <li>Copy the value of <code>tb.auth0.sid</code> (just the value is fine - no <code>name=</code> needed). Pasting the whole <code>Cookie:</code> request header from a GraphQL request also works and is a bit more robust.</li>
  <li>Paste it below and save.</li>
</ol>
<p style="font-size:13px;opacity:.8">Tip: install the Rocket Money MCP browser extension and this becomes automatic -
it keeps the session fresh while you're logged in, no pasting.</p>
<form method="post" action="/auth/submit">
  <textarea name="cookie" placeholder="paste the tb.auth0.sid value (or the full Cookie header)" autofocus></textarea>
  <button type="submit">Save session</button>
</form>`));
}
// ── JSON API for the browser extension ─────────────────────────────
// Same trust model as the paste page: this hostname is gated at the Cloudflare
// edge (Email OTP for a human, or the extension's Access service token), so a
// request that reaches here is already the account owner. No app-layer secret.
/** GET /auth/status -> current session state as JSON (drives the popup). */
export function authStatus(_req, res) {
    res.status(200).json(sessionStatus());
}
/**
 * POST /auth/ingest {cookie} -> seed/refresh the session from the extension.
 * `cookie` may be a full Cookie header, a tb.auth0.sid pair, or the bare value.
 */
export function ingestAuth(req, res) {
    const raw = String(req.body?.cookie ?? "");
    if (!raw.trim()) {
        res.status(400).json({ ok: false, error: "missing cookie" });
        return;
    }
    const err = seedSession(raw);
    if (err) {
        res.status(400).json({ ok: false, error: err });
        return;
    }
    res.status(200).json({ ok: true, ...sessionStatus() });
}
/**
 * POST /auth/login -> kick off a headless auto-login (bypasses the cooldown).
 * We don't await the whole run (it may block on an SMS code); we give it a beat
 * to reach a decision point, then re-render /auth (which shows the OTP box if the
 * run parked on the SMS challenge).
 */
export async function triggerLogin(_req, res) {
    void attemptLogin("manual /auth trigger", true);
    await Promise.race([sleep(3500), (async () => {
            // resolve early once the run either finishes or parks for OTP
            while (!otpPending() && loginState().inFlight)
                await sleep(200);
        })()]);
    res.redirect(303, "/auth");
}
/** POST /auth/otp {code} -> feed the SMS code to the parked login run. */
export function postOtp(req, res) {
    const code = String(req.body?.code ?? "").trim();
    if (!code) {
        res.status(400).type("html").send(page(`<h1 class="bad">No code provided</h1><p><a href="/auth">Back</a></p>`));
        return;
    }
    const accepted = submitOtp(code);
    if (!accepted) {
        res.status(409).type("html").send(page(`<h1 class="bad">No login is waiting for a code</h1><p>The run may have timed out. <a href="/auth">Back</a></p>`));
        return;
    }
    // Give the resumed run a moment to complete before showing status.
    res.redirect(303, "/auth");
}
export function submitAuth(req, res) {
    const raw = String(req.body?.cookie ?? "");
    if (!raw.trim()) {
        res.status(400).type("html").send(page(`<h1>No cookie provided</h1><p><a href="/auth">Back</a></p>`));
        return;
    }
    const err = seedSession(raw);
    if (err) {
        res.status(400).type("html").send(page(`<h1 class="bad">Couldn't save that</h1><p>${err}</p><p><a href="/auth">Try again</a></p>`));
        return;
    }
    res.status(200).type("html").send(page(`<h1 class="ok">Session saved</h1>${statusBlock()}<p>Rocket Money tools are ready. You can close this tab and talk to Claude about your finances.</p><p><a href="/auth">Back to session page</a></p>`));
}
