import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RMAuthError } from "./rm/client.js";
import * as rm from "./rm/client.js";
import * as fmt from "./rm/format.js";
import { sessionStatus } from "./rm/session.js";
import { getSchedulerConfig, runNow, setSchedulerConfig } from "./amazon/scheduler.js";
import { syncAmazonSince } from "./amazon/sync.js";

const AUTH_HINT =
  "Rocket Money session is not active. Open the auth page (rocketmoney-auth.graysons.network) and paste a fresh `tb.auth0.sid` cookie from a logged-in app.rocketmoney.com browser tab.";

/** Wrap a tool body so RMAuthError becomes a clean, actionable MCP error. */
function tool<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      const result = await fn(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof RMAuthError ? `${AUTH_HINT}\n\n(${err.message})` : String(err);
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  };
}

const READ = { readOnlyHint: true, openWorldHint: true } as const;

/** Build a fresh McpServer with all read-only Rocket Money tools registered. */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "rocketmoney", version: "1.0.0" },
    {
      instructions:
        "Access to the user's Rocket Money finances: accounts and balances, transactions, spending by category, budgets, net worth, and subscriptions (all read-only, USD). The ONLY tools that write to Rocket Money are the amazon_sync_* tools: they enrich Amazon transactions by setting each one's note to the ordered item name and its spending category, matched from Amazon order-confirmation emails. amazon_sync_preview is a safe dry run; amazon_sync_apply writes; amazon_sync_enable/disable control an autonomous background sync. If a tool reports the session is inactive, the user must re-authenticate at the auth page.",
    },
  );

  server.registerTool(
    "session_status",
    {
      title: "Session status",
      description:
        "Check whether the Rocket Money session is currently authenticated. Use this first if other tools report auth errors.",
      inputSchema: {},
      annotations: READ,
    },
    tool(async () => {
      const local = sessionStatus();
      if (local.status !== "live") return { ...local, authenticated: false, hint: AUTH_HINT };
      // Confirm liveness against RM (also rotates the cookie).
      const viewerId = await rm.authenticationCheck();
      return { ...local, authenticated: Boolean(viewerId) };
    }),
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description:
        "List every linked institution and account with its current balance, type, and masked number.",
      inputSchema: {},
      annotations: READ,
    },
    tool(async () => fmt.shapeAccounts(await rm.getAccounts())),
  );

  server.registerTool(
    "get_account",
    {
      title: "Get account detail",
      description:
        "Detailed view of one account: current/available balance, credit limit, liability details (statement balance, minimum payment, due date, APRs), and recent daily balance history. Pass the account node id from list_accounts.",
      inputSchema: {
        account_id: z.string().describe("The account node id (the `id` field from list_accounts)"),
      },
      annotations: READ,
    },
    tool(async ({ account_id }: { account_id: string }) =>
      fmt.shapeAccountDetail(await rm.getAccountDetail(account_id)),
    ),
  );

  server.registerTool(
    "net_worth",
    {
      title: "Net worth",
      description:
        "Net worth broken down into cash, savings, investments, and debts (credit cards, loans), with per-account values and a recent net-worth trend.",
      inputSchema: {
        use_equity: z
          .boolean()
          .optional()
          .describe("Value real estate at equity instead of market value (default false)"),
      },
      annotations: READ,
    },
    tool(async ({ use_equity }: { use_equity?: boolean }) =>
      fmt.shapeNetWorth(await rm.getNetWorth(use_equity ?? false)),
    ),
  );

  server.registerTool(
    "spending_summary",
    {
      title: "Spending summary",
      description:
        "This month's spending and earnings vs last month, plus a per-category spending breakdown (largest first). Amounts in USD.",
      inputSchema: {},
      annotations: READ,
    },
    tool(async () => fmt.shapeSpending(await rm.getSpending())),
  );

  server.registerTool(
    "budgets",
    {
      title: "Budgets",
      description:
        "Budget view: earnings for this and the prior three months, and per-category spend with a 3-month trend.",
      inputSchema: {},
      annotations: READ,
    },
    tool(async () => fmt.shapeBudgets(await rm.getBudgets())),
  );

  server.registerTool(
    "subscriptions",
    {
      title: "Subscriptions / recurring",
      description:
        "Active recurring charges and subscriptions with their category, next expected bill date, and next-charge estimate.",
      inputSchema: {},
      annotations: READ,
    },
    tool(async () => fmt.shapeRecurring(await rm.getRecurring())),
  );

  server.registerTool(
    "upcoming_bills",
    {
      title: "Upcoming bills",
      description:
        "Upcoming subscription/bill charges in the next N days (default 28), with dates, amounts, and a total.",
      inputSchema: {
        days: z.number().int().min(1).max(90).optional().describe("Look-ahead window in days (default 28)"),
      },
      annotations: READ,
    },
    tool(async ({ days }: { days?: number }) => fmt.shapeUpcoming(await rm.getUpcoming(days ?? 28))),
  );

  server.registerTool(
    "search_transactions",
    {
      title: "Search transactions",
      description:
        "Search transactions by merchant/description text and/or since a date. Both filters optional; omit query to list recent transactions. Amounts in USD; returns up to ~1200 matches.",
      inputSchema: {
        query: z.string().optional().describe("Merchant or description text, e.g. 'Amazon'"),
        since: z.string().optional().describe("Only transactions on/after this date (YYYY-MM-DD)"),
      },
      annotations: READ,
    },
    tool(async ({ query, since }: { query?: string; since?: string }) => {
      const txns = await rm.searchTransactions(query ?? null, since ?? null);
      return {
        count: txns.length,
        transactions: txns.map((t) => ({
          id: t.nodeId,
          date: t.date,
          amount: fmt.usd(t.amountCents),
          name: t.name,
          category: t.categoryLabel,
          note: t.note,
        })),
      };
    }),
  );

  server.registerTool(
    "category_transactions",
    {
      title: "Transactions in a category",
      description:
        "List this month's transactions within one spending category. Pass the category node id (from spending_summary/budgets categories, or a base64 TransactionCategory id).",
      inputSchema: {
        category_id: z.string().describe("The TransactionCategory node id"),
      },
      annotations: READ,
    },
    tool(async ({ category_id }: { category_id: string }) => {
      const data = await rm.getCategoryTransactions(category_id);
      const nodes: Record<string, unknown>[] = [];
      rm.collectByType(data, "Transaction", nodes);
      return {
        count: nodes.length,
        transactions: nodes.map((o) => ({
          id: o.id,
          date: o.date,
          amount: fmt.usd(o.amount),
          name: o.longName ?? o.shortName,
          note: o.note ?? null,
        })),
      };
    }),
  );

  // ── Amazon enrichment (the only WRITE tools) ─────────────────────
  const WRITE = { readOnlyHint: false, openWorldHint: true } as const;

  server.registerTool(
    "amazon_sync_preview",
    {
      title: "Preview Amazon sync",
      description:
        "DRY RUN: match recent Amazon transactions to Amazon order-confirmation emails and show what note (item name) + category WOULD be written. Writes nothing. Use this before amazon_sync_apply.",
      inputSchema: {
        since_days: z
          .number()
          .int()
          .min(1)
          .max(400)
          .optional()
          .describe("Look back this many days (default: the scheduler's lookback, 10)"),
      },
      annotations: READ,
    },
    tool(async ({ since_days }: { since_days?: number }) => runNow(true, since_days)),
  );

  server.registerTool(
    "amazon_sync_apply",
    {
      title: "Apply Amazon sync",
      description:
        "WRITES to Rocket Money: enrich recent Amazon transactions by setting each one's note to the ordered item name and its spending category. Idempotent (skips rows already synced unchanged). Run amazon_sync_preview first to see the changes.",
      inputSchema: {
        since_days: z.number().int().min(1).max(400).optional().describe("Look back this many days (default 10)"),
      },
      annotations: WRITE,
    },
    tool(async ({ since_days }: { since_days?: number }) => runNow(false, since_days)),
  );

  server.registerTool(
    "amazon_sync_backfill",
    {
      title: "Backfill Amazon sync",
      description:
        "WRITES to Rocket Money: one historical enrichment pass over every Amazon transaction on/after a date. Searches Amazon confirmation emails across Inbox, Archive, Trash, and Junk. Idempotent.",
      inputSchema: {
        since: z.string().describe("Enrich transactions on/after this date (YYYY-MM-DD)"),
        dry_run: z.boolean().optional().describe("Preview only, write nothing (default false)"),
      },
      annotations: WRITE,
    },
    tool(async ({ since, dry_run }: { since: string; dry_run?: boolean }) =>
      syncAmazonSince(since, dry_run ?? false),
    ),
  );

  server.registerTool(
    "amazon_sync_status",
    {
      title: "Amazon sync status",
      description:
        "Show the autonomous Amazon-sync scheduler state (enabled, interval, lookback, last run + last run's summary) and whether the Rocket Money session is live.",
      inputSchema: {},
      annotations: READ,
    },
    tool(async () => ({ scheduler: getSchedulerConfig(), session: sessionStatus() })),
  );

  server.registerTool(
    "amazon_sync_enable",
    {
      title: "Enable autonomous Amazon sync",
      description:
        "Turn ON the background Amazon-sync scheduler. It then WRITES enrichment to Rocket Money every `interval_hours` (default 6) over the last `lookback_days` (default 10), whenever the session is live. Disabled by default.",
      inputSchema: {
        interval_hours: z.number().int().min(1).max(168).optional().describe("Hours between runs (default 6)"),
        lookback_days: z.number().int().min(1).max(60).optional().describe("Days looked back each run (default 10)"),
      },
      annotations: WRITE,
    },
    tool(async ({ interval_hours, lookback_days }: { interval_hours?: number; lookback_days?: number }) =>
      setSchedulerConfig({
        enabled: true,
        ...(interval_hours !== undefined ? { intervalHours: interval_hours } : {}),
        ...(lookback_days !== undefined ? { lookbackDays: lookback_days } : {}),
      }),
    ),
  );

  server.registerTool(
    "amazon_sync_disable",
    {
      title: "Disable autonomous Amazon sync",
      description: "Turn OFF the background Amazon-sync scheduler. On-demand amazon_sync_apply/preview still work.",
      inputSchema: {},
      annotations: WRITE,
    },
    tool(async () => setSchedulerConfig({ enabled: false })),
  );

  return server;
}
