# Rocket Money MCP Sync (Chrome extension)

Keeps your Rocket Money MCP server session fresh automatically. While you're
logged into Rocket Money in this browser, the extension reads the rolling
`tb.auth0.sid` session cookie and pushes it to your MCP server's
`/auth/ingest` endpoint - on every cookie rotation and on a 10-minute
heartbeat - so you never paste a cookie again.

## How it authenticates to the server

The ingest endpoint lives on `rocketmoney-auth.graysons.network`, which is
gated by Cloudflare Access. The extension authenticates with a **Cloudflare
Access service token** (a `CF-Access-Client-Id` / `CF-Access-Client-Secret`
pair) that you paste into the extension's options. Nothing is committed to the
repo; the token lives only in `chrome.storage.local`.

## Load it

1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. **Load unpacked** -> select this `extension/` folder.
3. Click the extension's **Details -> Extension options** (or the puzzle-piece
   menu -> Options) and fill in:
   - **Ingest URL**: `https://rocketmoney-auth.graysons.network/auth/ingest` (default)
   - **CF-Access-Client-Id**: the service token client id (ends in `.access`)
   - **CF-Access-Client-Secret**: the 64-char secret
4. Click **Save & sync now**. The popup should show **Server session: live**.

## Use it

- Stay logged into [app.rocketmoney.com](https://app.rocketmoney.com). That's it.
- Click the toolbar icon for status (server session, browser login, last sync)
  and a manual **Sync now** button.
- Badge: `ok` synced, `out` not logged into Rocket Money, `cfg` needs the token,
  `err` push failed (open the popup for the reason).

## Notes

- The cookie is HttpOnly; only the extension `cookies` API can read it (a page
  script cannot). That's why this is an extension and not a bookmarklet.
- `tb.auth0.sid` is a rolling session - the extension keeps the server in
  lockstep with the browser, so a rare rotation collision self-heals on the
  next push. If you fully log out of Rocket Money, the server session lapses
  until you log back in.
- The manual paste page at `https://rocketmoney-auth.graysons.network/auth`
  still works as a fallback (and now accepts just the bare cookie value).
