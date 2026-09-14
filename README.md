# rocketmoney-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[Rocket Money](https://www.rocketmoney.com). It lets an MCP client (Claude Desktop,
claude.ai, etc.) browse your accounts, transactions, spending, budgets, net worth,
and subscriptions so you can *talk to an assistant about your finances* - and make
targeted edits (transaction notes and categories, recurring-charge corrections).

Reads are annotated `readOnlyHint`; the mutating tools are marked `readOnlyHint: false`,
and `delete_subscription` additionally carries `destructiveHint`.

## Tools

### Read

| Tool | What it returns |
| --- | --- |
| `session_status` | Whether the Rocket Money session is authenticated |
| `list_accounts` | Every linked institution + account with current balance |
| `get_account` | One account's detail: balances, credit limit, liability/APRs, balance history |
| `net_worth` | Net worth split into cash / savings / investments / debts, with trend |
| `spending_summary` | This month vs last month spend + earnings, by-category breakdown |
| `budgets` | Earnings and per-category spend across the last four months |
| `subscriptions` | Every recurring charge, active and inactive, with amount, cadence, account and last/next charge |
| `get_subscription` | One recurring charge in full, with 12 months of charge history |
| `upcoming_bills` | Upcoming charges in the next N days |
| `search_transactions` | Transactions by merchant text and/or date (incl. current note + category) |
| `category_transactions` | This month's transactions within one category |
| `list_categories` | The full category catalog (default + custom) with labels + node ids |

### Write

| Tool | What it does |
| --- | --- |
| `set_transaction_note` | Set (or clear) one transaction's free-text note |
| `set_transaction_category` | Recategorize one transaction (accepts a category label, numeric id, or node id); optionally applies to all related transactions from the same merchant |
| `set_asset_value` | Set a manually-tracked asset's value |
| `update_subscription` | Correct a recurring charge's name, amount, cadence or dates |
| `mark_subscription_active` | Tell Rocket Money a subscription it wrote off is still being charged |
| `delete_subscription` | Remove a recurring charge from the list (not a cancellation) |

All amounts are in USD. To recategorize, call `list_categories` first to see valid
labels, then pass e.g. `category: "Groceries"` to `set_transaction_category` - the
server resolves the label to the right node id.

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
You grab the `tb.auth0.sid` cookie from a logged-in `app.rocketmoney.com` browser tab
and paste it into the server's `/auth` page. The server keeps a **rotating cookie jar**
(Rocket Money re-issues the cookie on every response, ~3h48m rolling TTL) persisted to
disk, and runs a keepalive loop. There is no offline refresh token, so when the session
eventually expires you re-paste a fresh cookie.

The cookie lives only on the machine running this server and is sent only to Rocket
Money's own API.

## Endpoints

| Path | Purpose |
| --- | --- |
| `POST /mcp` | MCP streamable-HTTP transport (stateless) |
| `GET /auth` | Paste-a-cookie session page |
| `POST /auth/submit` | Session intake |
| `GET /healthz` | Health check |

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
| `ROCKETMONEY_KEEPALIVE_MS` | `7200000` | Keepalive interval (2h) |
| `ROCKETMONEY_WEB_CLIENT_VERSION` | captured default | `x-truebill-web-client-version` header |

## Deployment

Designed to run behind an authenticating gateway (e.g. a Cloudflare Access / OAuth
front door) so the `/mcp` and `/auth` endpoints are never exposed unauthenticated —
the server itself holds a live financial session and must not be publicly reachable.

## Notes

- If a tool returns `PersistedQueryNotFound`, Rocket Money rotated a GraphQL query
  hash. This happens every few weeks, because a hash is tied to one build of RM's
  web bundle. The error names the page to re-capture from: open it with devtools
  recording, find the `client-api.rocketmoney.com/graphql` POST whose
  `operationName` matches, copy `extensions.persistedQuery.sha256Hash`, and update
  `PERSISTED` in `src/rm/client.ts`.
- Not affiliated with or endorsed by Rocket Money / Rocket Companies.

## License

MIT
