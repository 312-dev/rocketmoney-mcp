import type { Request, Response } from "express";
import { seedSession, sessionStatus } from "./rm/session.js";

// The paste-a-cookie page. Served on rocketmoney-auth.graysons.network, which
// routes tunnel -> here directly (NOT through the OAuth Worker), and is gated at
// the Cloudflare edge by the single-user Access policy. So reaching this page
// already means the request is the account owner; we don't add our own password.

function page(body: string): string {
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

function statusBlock(): string {
  const s = sessionStatus();
  const label =
    s.status === "live"
      ? `<span class="ok">&#9679; live</span> (last refreshed ${s.refreshedAt ?? "?"})`
      : s.status === "dead"
        ? `<span class="bad">&#9679; expired</span> - re-paste below${s.lastError ? ` (${s.lastError})` : ""}`
        : `<span class="bad">&#9679; not configured</span>`;
  return `<div class="status">Current session: ${label}</div>`;
}

export function renderAuthPage(_req: Request, res: Response): void {
  res.status(200).type("html").send(
    page(`
<h1>Rocket Money MCP session</h1>
${statusBlock()}
<p>Rocket Money has no third-party login, so this connector reuses your own web
session. Grab the cookie and paste it here - it stays on your gateway machine and
is never sent anywhere but Rocket Money's API.</p>
<ol>
  <li>Open <a href="https://app.rocketmoney.com" target="_blank" rel="noopener">app.rocketmoney.com</a> and make sure you're logged in.</li>
  <li>Open DevTools (&#8984;&#8997;I) &rarr; <b>Application</b> &rarr; <b>Cookies</b> &rarr; <code>https://app.rocketmoney.com</code>.</li>
  <li>Copy the value of <code>tb.auth0.sid</code> (or the whole <code>Cookie:</code> request header from any GraphQL request - more robust).</li>
  <li>Paste it below and save.</li>
</ol>
<form method="post" action="/auth/submit">
  <textarea name="cookie" placeholder="tb.auth0.sid=...   (or the full Cookie header)" autofocus></textarea>
  <button type="submit">Save session</button>
</form>`),
  );
}

export function submitAuth(req: Request, res: Response): void {
  const raw = String((req.body as { cookie?: string })?.cookie ?? "");
  if (!raw.trim()) {
    res.status(400).type("html").send(page(`<h1>No cookie provided</h1><p><a href="/auth">Back</a></p>`));
    return;
  }
  const err = seedSession(raw);
  if (err) {
    res.status(400).type("html").send(
      page(`<h1 class="bad">Couldn't save that</h1><p>${err}</p><p><a href="/auth">Try again</a></p>`),
    );
    return;
  }
  res.status(200).type("html").send(
    page(
      `<h1 class="ok">Session saved</h1>${statusBlock()}<p>Rocket Money tools are ready. You can close this tab and talk to Claude about your finances.</p><p><a href="/auth">Back to session page</a></p>`,
    ),
  );
}
