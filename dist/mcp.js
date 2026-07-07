import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RMAuthError } from "./rm/client.js";
import * as rm from "./rm/client.js";
import * as fmt from "./rm/format.js";
import { sessionStatus } from "./rm/session.js";
const AUTH_HINT = "Rocket Money session is not active. Open the auth page (rocketmoney-auth.graysons.network) and paste a fresh `tb.auth0.sid` cookie from a logged-in app.rocketmoney.com browser tab.";
/** Wrap a tool body so RMAuthError becomes a clean, actionable MCP error. */
function tool(fn) {
    return async (args) => {
        try {
            const result = await fn(args);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        catch (err) {
            const msg = err instanceof RMAuthError ? `${AUTH_HINT}\n\n(${err.message})` : String(err);
            return { content: [{ type: "text", text: msg }], isError: true };
        }
    };
}
const READ = { readOnlyHint: true, openWorldHint: true };
/** Build a fresh McpServer with all read-only Rocket Money tools registered. */
export function buildServer() {
    const server = new McpServer({ name: "rocketmoney", version: "1.0.0" }, {
        instructions: "Read-only access to the user's Rocket Money finances: accounts and balances, transactions, spending by category, budgets, net worth, and subscriptions. All amounts are in USD. This server never modifies anything in Rocket Money. If a tool reports the session is inactive, the user must re-authenticate at the auth page.",
    });
    server.registerTool("session_status", {
        title: "Session status",
        description: "Check whether the Rocket Money session is currently authenticated. Use this first if other tools report auth errors.",
        inputSchema: {},
        annotations: READ,
    }, tool(async () => {
        const local = sessionStatus();
        if (local.status !== "live")
            return { ...local, authenticated: false, hint: AUTH_HINT };
        // Confirm liveness against RM (also rotates the cookie).
        const viewerId = await rm.authenticationCheck();
        return { ...local, authenticated: Boolean(viewerId) };
    }));
    server.registerTool("list_accounts", {
        title: "List accounts",
        description: "List every linked institution and account with its current balance, type, and masked number.",
        inputSchema: {},
        annotations: READ,
    }, tool(async () => fmt.shapeAccounts(await rm.getAccounts())));
    server.registerTool("get_account", {
        title: "Get account detail",
        description: "Detailed view of one account: current/available balance, credit limit, liability details (statement balance, minimum payment, due date, APRs), and recent daily balance history. Pass the account node id from list_accounts.",
        inputSchema: {
            account_id: z.string().describe("The account node id (the `id` field from list_accounts)"),
        },
        annotations: READ,
    }, tool(async ({ account_id }) => fmt.shapeAccountDetail(await rm.getAccountDetail(account_id))));
    server.registerTool("net_worth", {
        title: "Net worth",
        description: "Net worth broken down into cash, savings, investments, and debts (credit cards, loans), with per-account values and a recent net-worth trend.",
        inputSchema: {
            use_equity: z
                .boolean()
                .optional()
                .describe("Value real estate at equity instead of market value (default false)"),
        },
        annotations: READ,
    }, tool(async ({ use_equity }) => fmt.shapeNetWorth(await rm.getNetWorth(use_equity ?? false))));
    server.registerTool("spending_summary", {
        title: "Spending summary",
        description: "This month's spending and earnings vs last month, plus a per-category spending breakdown (largest first). Amounts in USD.",
        inputSchema: {},
        annotations: READ,
    }, tool(async () => fmt.shapeSpending(await rm.getSpending())));
    server.registerTool("budgets", {
        title: "Budgets",
        description: "Budget view: earnings for this and the prior three months, and per-category spend with a 3-month trend.",
        inputSchema: {},
        annotations: READ,
    }, tool(async () => fmt.shapeBudgets(await rm.getBudgets())));
    server.registerTool("subscriptions", {
        title: "Subscriptions / recurring",
        description: "Active recurring charges and subscriptions with their category, next expected bill date, and next-charge estimate.",
        inputSchema: {},
        annotations: READ,
    }, tool(async () => fmt.shapeRecurring(await rm.getRecurring())));
    server.registerTool("upcoming_bills", {
        title: "Upcoming bills",
        description: "Upcoming subscription/bill charges in the next N days (default 28), with dates, amounts, and a total.",
        inputSchema: {
            days: z.number().int().min(1).max(90).optional().describe("Look-ahead window in days (default 28)"),
        },
        annotations: READ,
    }, tool(async ({ days }) => fmt.shapeUpcoming(await rm.getUpcoming(days ?? 28))));
    server.registerTool("search_transactions", {
        title: "Search transactions",
        description: "Search transactions by merchant/description text and/or since a date. Both filters optional; omit query to list recent transactions. Amounts in USD; returns up to ~1200 matches.",
        inputSchema: {
            query: z.string().optional().describe("Merchant or description text, e.g. 'Amazon'"),
            since: z.string().optional().describe("Only transactions on/after this date (YYYY-MM-DD)"),
        },
        annotations: READ,
    }, tool(async ({ query, since }) => {
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
    }));
    server.registerTool("category_transactions", {
        title: "Transactions in a category",
        description: "List this month's transactions within one spending category. Pass the category node id (from spending_summary/budgets categories, or a base64 TransactionCategory id).",
        inputSchema: {
            category_id: z.string().describe("The TransactionCategory node id"),
        },
        annotations: READ,
    }, tool(async ({ category_id }) => {
        const data = await rm.getCategoryTransactions(category_id);
        const nodes = [];
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
    }));
    return server;
}
