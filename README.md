# rocketmoney-mcp

A self-hosted [Model Context Protocol](https://modelcontextprotocol.io) server for
[Rocket Money](https://www.rocketmoney.com). It lets an MCP client (Claude Desktop,
claude.ai, etc.) browse your accounts, transactions, spending, budgets, net worth,
and subscriptions so you can *talk to an assistant about your finances* - and make
targeted edits (transaction notes and categories, recurring-charge corrections).

Reads are annotated `readOnlyHint`; the mutating tools are marked `readOnlyHint: false`,
and `delete_subscription` additionally carries `destructiveHint`. Start the server with
`ROCKETMONEY_READ_ONLY=1` and the write tools are never registered at all, so a client
cannot reach them.

## Security model, in one paragraph

Your Rocket Money session cookie is a live login to your finances. This server
holds it on disk and sends it only to Rocket Money's API, so **run the server
yourself, on a machine you control**, and put its `/auth` and `/mcp` endpoints
behind authentication. There is no hosted instance: nothing in this repo points
at a server the author operates, and the Chrome extension refuses to send the
cookie anywhere until you enter your own server's URL.

## Tools

### Read

| Tool | What it returns |
| --- | --- |
| `session_status` | Whether the Rocket Money session is authenticated, and which linked institutions stopped syncing (`stale_connections`, with each account's last transaction date) |
| `list_accounts` | Every linked institution + account with current balance |
| `get_account` | One account's detail: balances, credit limit, liability/APRs, balance history |
| `net_worth` | Net worth split into cash / savings / investments / debts, with trend |
| `list_holdings` | Investment holdings across the linked brokerage accounts |
| `list_assets` | Manually-tracked assets and their current values |
| `spending_summary` | This month vs last month spend + earnings, by-category breakdown |
| `budgets` | Earnings and per-category spend across the last four months |
| `subscriptions` | Every recurring charge, active and inactive, with amount, cadence, account and last/next charge |
| `get_subscription` | One recurring charge in full, with 12 months of charge history |
| `upcoming_bills` | Upcoming charges in the next N days |
| `search_transactions` | Transactions by merchant text and/or date (incl. current note + category) |
| `category_transactions` | This month's transactions within one category |
| `list_categories` | The full category catalog (default + custom) with labels + node ids |
| `list_rules` | Every transaction rule: conditions, updates, matched count |
| `get_rule` | One rule plus a sample of the transactions it matches (with ids) |
| `preview_rule` | Dry run: match count and sample for a set of conditions, saves nothing |

### Write (absent under `ROCKETMONEY_READ_ONLY=1`)

| Tool | What it does |
| --- | --- |
| `set_transaction_note` | Set (or clear) one transaction's free-text note |
| `set_transaction_category` | Recategorize one transaction (accepts a category label, numeric id, or node id); optionally applies to all related transactions from the same merchant |
| `set_transactions_category` | Recategorize a list of transactions in one call |
| `set_asset_value` | Set a manually-tracked asset's value |
| `update_subscription` | Correct a recurring charge's name, amount, cadence or dates |
| `mark_subscription_active` | Tell Rocket Money a subscription it wrote off is still being charged |
| `delete_subscription` | Remove a recurring charge from the list (not a cancellation) |
| `create_rule` | Create a transaction rule (category, rename, ignore, tax deductible) |
| `update_rule` | Change a rule's conditions or updates (Rocket Money gives it a new id) |
| `delete_rule` | Delete a rule, keeping (default) or undoing its past changes |

All amounts are in USD. To recategorize, call `list_categories` first to see valid
labels, then pass e.g. `category: "Groceries"` to `set_transaction_category` - the
server resolves the label to the right node id.

### Transaction rules

A rule matches on name (contains or exactly), amount (exact, range, or one-sided;
any/debit/credit), any of a set of accounts, and a posted-date range. All conditions
must hold. It can set the category, rename, ignore (from budget or everything) and
mark tax deductible. Rocket Money's rule API has no tags, no OR, and no category
condition.

Rocket Money has no "future transactions only" switch: saving a rule applies it to
every transaction it matches at that moment. `create_rule`/`update_rule` default to
`apply_to_existing=true`, matching the web app, and the response reports how many
existing transactions were updated. `apply_to_existing=false` instead adds
`date_from` = tomorrow and refuses to save if a preview still finds a match;
`update_rule` with `false` refuses a rule that already matches anything, since saving
would re-apply it.

### Categorization conventions (Venmo, Zelle, group payments)

How person-to-person payments get categorized is set out in
[`CATEGORIZATION.md`](CATEGORIZATION.md). Each payment is filed by what it paid for,
repayments net inside the category of the original charge, and the `Venmo` category holds
only transfers between your own accounts. Rocket Money rules can't express this, so an
assistant applies it by hand with the tools above. Personal specifics (ids, people, rent)
go in a gitignored `CATEGORIZATION.local.md`.

### What you can and cannot change about a subscription

`update_subscription` takes only what you want changed and preserves the rest from a
fresh read, because Rocket Money's mutation replaces the whole record and requires the
name on every call.

**Cadence is charges per year**, not an interval: `frequency: 12` is monthly, `1` is
annual, `2` is semi-annual. A subscription with no frequency at all reads as
`irregular`, which is what Rocket Money uses for usage-based charges.

**You cannot mark a subscription cancelled or inactive.** `UpdateSubscriptionInput`
accepts `id`, `service_name`, `service_id`, `amount`, `frequency`, `start_date`,
`end_date`, `next_expected_date` and `service_type`, and nothing else; `active` is not
among them. Rocket Money flips `active` itself when the charges stop. The API has
`markSubscriptionActive` for the opposite direction, and a `deactivateManualSubscription`
that only applies to hand-added subscriptions, so a charge Rocket Money detected from
transactions cannot be deactivated through the API at all. What is left is
`delete_subscription`, which takes the row off the list entirely.

`end_date` records the last charge that was seen. Setting it does not deactivate
anything.

The `canSubmitCancellationRequest` flag on each row is Rocket Money's own concierge
cancellation offer, surfaced read-only. The mutations behind it (`requestCancelV3` and
friends) file a real cancellation with a real merchant and are deliberately not wired up
as tools.

> **Amazon enrichment** (setting notes to the real item name + a fitting category,
> matched from Amazon order emails) used to live here as dedicated `amazon_sync_*`
> tools plus an autonomous scheduler. That has moved out to the on-demand
> `rocketmoney-amazon-sync` skill, which drives the generic read/write tools above.

## How auth works

Rocket Money has no third-party OAuth, so this server reuses your own web session.

**Session cookie.** The server holds Rocket Money's `tb.auth0.sid` cookie in a
**rotating cookie jar** persisted to `$ROCKETMONEY_STATE_DIR/session.json`: every
response re-issues the cookie, and every API call is serialized so two requests can
never race the rotation. A keepalive loop calls `RefreshAuthToken` every
`ROCKETMONEY_KEEPALIVE_MS`. There is no offline refresh token, and in practice the
session dies roughly every 30-60 minutes, so it has to be re-created regularly.

**Seeding it by hand.** Paste the cookie value from a logged-in `app.rocketmoney.com`
tab into the `/auth` page (just the value is fine, or the whole Cookie header).

**Auto-login** (`ROCKETMONEY_AUTO_LOGIN=1` plus `ROCKETMONEY_EMAIL` /
`ROCKETMONEY_PASSWORD`; the launchd setup reads these from the macOS Keychain, see
`start.sh`). When the session dies, the server drives Rocket Money's Auth0 login in
Chrome (`rebrowser-puppeteer-core` + the stealth plugin) with a **persistent
Chrome profile** in the state dir, then seeds the new cookie into the jar:

1. *Warm renewal:* if the profile still holds a working session, it is reused (a few
   seconds, no form).
2. *Form login:* otherwise it fills in email and password. Because the profile is a
   device Auth0 already trusts, this usually skips MFA.
3. *SMS MFA:* if Auth0 does challenge, the run waits up to ~4 minutes for the code,
   typed into `/auth` (`POST /auth/otp`) or forwarded from a phone
   (`POST /auth/sms`, guarded by `ROCKETMONEY_SMS_WEBHOOK_SECRET`).

Details that keep it reliable:

- **Every candidate cookie is checked against the API** (`AuthenticationCheck`) before
  it is saved. A Chrome profile keeps stale cookies around, and saving one used to
  report success and then fail again minutes later.
- **Headless mode** (`ROCKETMONEY_LOGIN_HEADLESS`): with `auto`, the run is headless,
  retried headless once, and only then falls back to a visible window. No retry once a
  run reaches the SMS step (that would text a second code). On Fly the default
  headful mode is kept: from a datacenter IP headless gets bot-flagged.
- **Rate limit:** at most one run at a time, with exponential backoff (15 min, 30 min,
  ... capped at 6 h) to stay clear of Auth0 attack protection. The `/auth` "Log in now"
  button bypasses the cooldown.
- **Offline:** if Chrome reports no network, the run stops without retrying or
  opening a window, and does not grow the backoff.
- Each run's outcome is written to `$ROCKETMONEY_STATE_DIR/login-last.json` (logs have
  no timestamps), and failures save a screenshot (`login-<tag>.png`) beside it.

The cookie, the Chrome profile and the credentials stay on the machine running this
server; the cookie is sent only to Rocket Money's own API.

## Endpoints

| Path | Purpose |
| --- | --- |
| `POST /mcp` | MCP streamable-HTTP transport (stateless) |
| `GET /auth` (also `/`) | Session page: paste a cookie, see login status, enter an SMS code |
| `POST /auth/submit` | Session intake (pasted cookie) |
| `POST /auth/login` | Start an auto-login now, bypassing the cooldown |
| `POST /auth/otp` | Hand an SMS code to a login run waiting on MFA |
| `POST /auth/sms` | Phone SMS-forwarder webhook (`X-SMS-Secret` header or `?secret=`) |
| `GET /api/transactions[/:slug]` | Last `ROCKETMONEY_API_LOOKBACK_DAYS` of transactions as JSON (bearer `ROCKETMONEY_API_TOKEN`; fails closed when unset) |
| `GET /api/budget` | Budgets, recurring merchants, upcoming bills and spending in one read (same token) |
| `GET /healthz` | Health check |

`/auth/ingest` (the Chrome extension's push target) is **not registered in this
build**: it accepted requests from any website. See Known shortcomings.

## Running locally

```bash
npm install
npm run build
ROCKETMONEY_STATE_DIR=./.state PORT=8080 node dist/index.js
# open http://localhost:8080/auth and paste your cookie
```

### Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `ROCKETMONEY_STATE_DIR` | `/data/rocketmoney` | Where the rotating session is persisted |
| `ROCKETMONEY_READ_ONLY` | unset | `1` to leave the write tools unregistered |
| `ROCKETMONEY_KEEPALIVE_MS` | `7200000` | Keepalive interval (2h; the launchd plist uses 30 min) |
| `ROCKETMONEY_AUTO_LOGIN` | unset | `1` to re-login automatically when the session dies |
| `ROCKETMONEY_EMAIL` / `ROCKETMONEY_PASSWORD` | unset | Login credentials for auto-login (`start.sh` reads them from the Keychain) |
| `ROCKETMONEY_LOGIN_HEADLESS` | `0` | Auto-login browser: `0` headful (needed on Fly), `auto` headless with a headful fallback, `1` headless only |
| `CHROMIUM_PATH` | `/usr/bin/chromium` | Browser binary for auto-login |
| `ROCKETMONEY_LOGIN_PROXY` | unset | Proxy for the login browser (e.g. a residential SOCKS5 exit for Fly) |
| `ROCKETMONEY_SMS_WEBHOOK_SECRET` | unset | Shared secret for `POST /auth/sms` |
| `ROCKETMONEY_API_TOKEN` | unset | Bearer token for `/api/*` (unset = `/api/*` refuses every request) |
| `ROCKETMONEY_API_LOOKBACK_DAYS` | `7` | Window returned by `/api/transactions` |
| `ROCKETMONEY_WEB_CLIENT_VERSION` | captured default | `x-truebill-web-client-version` header |

## Deployment

Designed to run behind an authenticating gateway (e.g. a Cloudflare Access / OAuth
front door) so the `/mcp` and `/auth` endpoints are never exposed unauthenticated -
the server itself holds a live financial session and must not be publicly reachable.

Locally it runs as the launchd agent in `com.akseldkw.rocketmoney-mcp.plist`
(`start.sh` → `dist/index.js` on `127.0.0.1:8787`). After changing `src/`, run
`npm run deploy`: it rebuilds `dist/` and restarts the agent with
`launchctl kickstart -k`. A `post-merge` git hook runs it after merges into `main`.

## Notes

- Rocket Money rotates GraphQL query hashes every few weeks, because a hash is tied
  to one build of its web bundle. A rotated hash no longer breaks a tool: the read
  is resent with the query text in `src/rm/query-text.ts` and the server logs
  `PersistedQueryNotFound ... Falling back`. To fix the hash properly, open the page
  the log line names with devtools recording, export a HAR, and run
  `npm run refresh-hashes -- <file.har>`, which rewrites `PERSISTED` in
  `src/rm/client.ts`. `npm run refresh-hashes -- --bundle` regenerates the fallback
  query text from the public bundle (no login needed). Transaction-rule tools and all
  writes send their own query text, so they never depend on a hash.
- Not affiliated with or endorsed by Rocket Money / Rocket Companies.

## Known shortcomings

- **Short sessions.** Rocket Money's session lasts roughly 30-60 minutes in practice,
  so auto-login runs many times a day. It depends on a stored password and on Auth0
  not tightening bot detection; if that changes, logins fail until it is fixed.
- **Partial outages can still open a window.** Only "no network" errors count as
  offline. A timeout or connection reset gets the headless retry and then the visible
  fallback.
- **Chrome extension is orphaned.** `extension/` still pushes to `/auth/ingest`, which
  this build no longer registers. Paste at `/auth` or rely on auto-login instead.
- **Query hashes rotate.** Reads fall back to bundled query text, which keeps working
  until Rocket Money changes the schema itself; refreshing the hashes is a HAR capture
  plus `npm run refresh-hashes` (see Notes).
- **Subscriptions can't be marked cancelled** through the API (see above), only deleted.
- **Logs have no timestamps**; `login-last.json` is the only timestamped record of a
  login run.
- **No CI.** Tests (`npm test`) and the typecheck only run locally.
- **USD only.**

## TODO

- [ ] Decide on `feat/generic-transaction-writes`: its 2026-10-27 hash fix is now in
      `main`; its gate-note write endpoint (with a test) is not, and it conflicts with
      the current `client.ts` / `index.ts`.
- [ ] Apply the dependency bumps upstream's Dependabot proposed (notably MCP SDK
      1.32.0; the copied branches were deleted from this fork), and consider turning
      Dependabot on for this fork.
- [ ] Remove `extension/`, or bring back `/auth/ingest` behind authentication.
- [ ] Timestamp the server log.
- [ ] Add CI for `npm test` and `npm run typecheck`.
- [ ] Treat timeouts and connection resets that come from local network trouble as
      offline, without hiding real Rocket Money failures.
- [ ] Capture the HAR for `npm run refresh-hashes` automatically (e.g. from a
      headless page load) instead of by hand.

## License

MIT
