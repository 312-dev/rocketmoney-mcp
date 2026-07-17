import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RMAuthError } from "./rm/client.js";
import * as rm from "./rm/client.js";
import * as fmt from "./rm/format.js";
import { sessionStatus } from "./rm/session.js";

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
        "Access to the user's Rocket Money finances (USD). Read tools: accounts and balances, transactions, spending by category, budgets, net worth, subscriptions, and the category catalog (list_categories). Write tools MUTATE the account: set_transaction_note sets/clears a transaction's note; set_transaction_category recategorizes a transaction (optionally every related transaction from the same merchant). To recategorize, first call list_categories to see valid labels/ids, then pass a label like \"Groceries\" (or a category id) to set_transaction_category. If a tool reports the session is inactive, the user must re-authenticate at the auth page.",
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

  server.registerTool(
    "list_categories",
    {
      title: "List spending categories",
      description:
        "The user's full Rocket Money category catalog (default + custom), each with its label, node id, and type (expense/income/ignored). Call this to discover valid categories before recategorizing a transaction with set_transaction_category.",
      inputSchema: {},
      annotations: READ,
    },
    tool(async () => {
      const cats = await rm.getTransactionCategories();
      return {
        count: cats.length,
        categories: cats.map((c) => ({
          id: c.id,
          nodeId: c.nodeId,
          label: c.label,
          type: c.type,
          categoryType: c.categoryType,
          includeInSpending: c.includeInSpending,
        })),
      };
    }),
  );

  // ── Write tools (these MUTATE Rocket Money) ──────────────────────
  const WRITE = { readOnlyHint: false, openWorldHint: true } as const;

  server.registerTool(
    "set_transaction_note",
    {
      title: "Set transaction note",
      description:
        "WRITES to Rocket Money: set (or clear) the free-text note on one transaction. Pass the transaction id from search_transactions/category_transactions. Use an empty string to clear the note. Returns the saved note.",
      inputSchema: {
        transaction_id: z.string().describe("The transaction node id (the `id` from search_transactions)"),
        note: z.string().describe("The note text to save. Pass an empty string to clear it."),
      },
      annotations: WRITE,
    },
    tool(async ({ transaction_id, note }: { transaction_id: string; note: string }) => {
      const saved = await rm.setTransactionNote(transaction_id, note);
      return { transaction_id, note: saved, ok: true };
    }),
  );

  server.registerTool(
    "set_transaction_category",
    {
      title: "Set transaction category",
      description:
        "WRITES to Rocket Money: recategorize one transaction. `category` accepts a category label (e.g. \"Groceries\"), a numeric category id, or a category node id - call list_categories first to see valid options. Set apply_to_all=true to recategorize every related transaction from the same merchant, not just this one.",
      inputSchema: {
        transaction_id: z.string().describe("The transaction node id (the `id` from search_transactions)"),
        category: z
          .string()
          .describe("Target category: a label like 'Groceries', a numeric id, or a category node id"),
        apply_to_all: z
          .boolean()
          .optional()
          .describe("Also recategorize all related transactions from the same merchant (default false)"),
      },
      annotations: WRITE,
    },
    tool(
      async ({
        transaction_id,
        category,
        apply_to_all,
      }: {
        transaction_id: string;
        category: string;
        apply_to_all?: boolean;
      }) => {
        const catNodeId = await rm.resolveCategoryNodeId(category);
        const updated = await rm.setTransactionCategory(transaction_id, catNodeId, apply_to_all ?? false);
        return { transaction_id, category, categoryNodeId: catNodeId, updatedCount: updated, ok: true };
      },
    ),
  );

  return server;
}
