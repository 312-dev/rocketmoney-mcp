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
/**
 * Account node id -> "Institution Name 1234", so transaction rows name the card
 * they hit instead of an opaque base64 id. Cached for the process lifetime: the
 * account list changes only when a new institution is linked, and every caller
 * falls back to the raw id on a miss.
 */
let accountLabelCache = null;
async function accountLabels() {
    if (accountLabelCache)
        return accountLabelCache;
    const shaped = fmt.shapeAccounts(await rm.getAccounts());
    const map = new Map();
    for (const inst of shaped.institutions ?? []) {
        for (const a of inst.accounts ?? []) {
            if (typeof a.id !== "string")
                continue;
            const parts = [inst.institution, a.name, a.mask].filter(Boolean).map(String);
            map.set(a.id, parts.join(" "));
        }
    }
    accountLabelCache = map;
    return map;
}
/** Build a fresh McpServer with all read-only Rocket Money tools registered. */
export function buildServer() {
    const server = new McpServer({ name: "rocketmoney", version: "1.0.0" }, {
        instructions: "Access to the user's Rocket Money finances (USD). Read tools: accounts and balances, transactions, spending by category, budgets, net worth, subscriptions, and the category catalog (list_categories). Write tools MUTATE the account: set_transaction_note sets/clears a transaction's note; set_transaction_category recategorizes a transaction (optionally every related transaction from the same merchant). To recategorize, first call list_categories to see valid labels/ids, then pass a label like \"Groceries\" (or a category id) to set_transaction_category. If a tool reports the session is inactive, the user must re-authenticate at the auth page.",
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
        description: "Detailed view of one account: current/available balance, credit limit, liability details (statement balance, minimum payment, due date, APRs), holdings (for investment accounts), and recent daily balance history. Pass the account node id from list_accounts.",
        inputSchema: {
            account_id: z.string().describe("The account node id (the `id` field from list_accounts)"),
        },
        annotations: READ,
    }, tool(async ({ account_id }) => fmt.shapeAccountDetail(await rm.getAccountDetail(account_id))));
    server.registerTool("list_holdings", {
        title: "List investment holdings",
        description: "List the securities held in one investment account (401k, IRA, brokerage): ticker, name, quantity, market value, and type. Pass the account node id from list_accounts. Returns an empty list for non-investment accounts.",
        inputSchema: {
            account_id: z.string().describe("The account node id (the `id` field from list_accounts)"),
        },
        annotations: READ,
    }, tool(async ({ account_id }) => {
        const nodes = [];
        rm.collectByType(await rm.getAccountDetail(account_id), "Holdings", nodes);
        const holdings = nodes.map((h) => ({
            ticker: h.tickerSymbol,
            name: h.name,
            quantity: h.quantity,
            value: fmt.usd(h.valueCents),
            type: h.type,
        }));
        const total = holdings.reduce((t, h) => t + (h.value ?? 0), 0);
        return { count: holdings.length, totalValue: Math.round(total * 100) / 100, holdings };
    }));
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
    server.registerTool("list_assets", {
        title: "List manual assets",
        description: "List the user's manually-tracked assets (vehicles, valuables, etc. under 'Other Assets') with their current value and asset id. These are assets added by hand, separate from linked institution accounts. Use the returned `id` with set_asset_value to update a balance.",
        inputSchema: {},
        annotations: READ,
    }, tool(async () => {
        const assets = await rm.getAssets();
        return {
            count: assets.length,
            assets: assets.map((a) => ({
                id: a.assetId,
                name: a.name,
                value: fmt.usd(a.valueCents),
                type: a.assetType,
                includeInNetWorth: a.includeInNetWorth,
            })),
        };
    }));
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
        description: "Search transactions by merchant/description text, since a date, and/or account. All filters optional; omit everything to list recent transactions. Amounts in USD; returns up to ~1200 matches. Each row carries the account it posted to - pass account_ids to filter server-side, which is far cheaper than pulling every account and discarding.",
        inputSchema: {
            query: z.string().optional().describe("Merchant or description text, e.g. 'Amazon'"),
            since: z.string().optional().describe("Only transactions on/after this date (YYYY-MM-DD)"),
            account_ids: z
                .array(z.string())
                .optional()
                .describe("Only these accounts. Account node ids from list_accounts; omit for all accounts"),
        },
        annotations: READ,
    }, tool(async ({ query, since, account_ids }) => {
        const txns = await rm.searchTransactions(query ?? null, since ?? null, 6, account_ids ?? []);
        const labels = txns.length ? await accountLabels() : new Map();
        return {
            count: txns.length,
            transactions: txns.map((t) => ({
                id: t.nodeId,
                date: t.date,
                amount: fmt.usd(t.amountCents),
                name: t.name,
                category: t.categoryLabel,
                account: t.accountId ? (labels.get(t.accountId) ?? t.accountId) : null,
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
    server.registerTool("list_categories", {
        title: "List spending categories",
        description: "The user's full Rocket Money category catalog (default + custom), each with its label, node id, and type (expense/income/ignored). Call this to discover valid categories before recategorizing a transaction with set_transaction_category.",
        inputSchema: {},
        annotations: READ,
    }, tool(async () => {
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
    }));
    // ── Write tools (these MUTATE Rocket Money) ──────────────────────
    const WRITE = { readOnlyHint: false, openWorldHint: true };
    server.registerTool("set_transaction_note", {
        title: "Set transaction note",
        description: "WRITES to Rocket Money: set (or clear) the free-text note on one transaction. Pass the transaction id from search_transactions/category_transactions. Use an empty string to clear the note. Returns the saved note.",
        inputSchema: {
            transaction_id: z.string().describe("The transaction node id (the `id` from search_transactions)"),
            note: z.string().describe("The note text to save. Pass an empty string to clear it."),
        },
        annotations: WRITE,
    }, tool(async ({ transaction_id, note }) => {
        const saved = await rm.setTransactionNote(transaction_id, note);
        return { transaction_id, note: saved, ok: true };
    }));
    server.registerTool("set_transaction_category", {
        title: "Set transaction category",
        description: "WRITES to Rocket Money: recategorize one transaction. `category` accepts a category label (e.g. \"Groceries\"), a numeric category id, or a category node id - call list_categories first to see valid options. Set apply_to_all=true to also sweep the merchant's other transactions (matched by descriptor). To recategorize a specific known set of transactions, prefer set_transactions_category - it is one round trip instead of N.",
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
    }, tool(async ({ transaction_id, category, apply_to_all, }) => {
        const catNodeId = await rm.resolveCategoryNodeId(category);
        const updated = await rm.setTransactionCategory(transaction_id, catNodeId, apply_to_all ?? false);
        return { transaction_id, category, categoryNodeId: catNodeId, updatedCount: updated, ok: true };
    }));
    server.registerTool("set_transactions_category", {
        title: "Set category on many transactions",
        description: "WRITES to Rocket Money: recategorize a batch of transactions in one call. Pass the transaction node ids (the `id` from search_transactions) and a category label, numeric id, or category node id. Returns updatedCount as reported by Rocket Money - compare it against the number of ids you sent rather than trusting ok:true.",
        inputSchema: {
            transaction_ids: z
                .array(z.string())
                .min(1)
                .describe("Transaction node ids to recategorize (the `id` values from search_transactions)"),
            category: z
                .string()
                .describe("Target category: a label like 'Groceries', a numeric id, or a category node id"),
        },
        annotations: WRITE,
    }, tool(async ({ transaction_ids, category }) => {
        const catNodeId = await rm.resolveCategoryNodeId(category);
        const updated = await rm.setTransactionsCategory(transaction_ids, catNodeId);
        return {
            requested: transaction_ids.length,
            updatedCount: updated,
            category,
            categoryNodeId: catNodeId,
            ok: updated === transaction_ids.length,
        };
    }));
    server.registerTool("set_asset_value", {
        title: "Set manual asset value",
        description: "WRITES to Rocket Money: update the value/balance of a manually-tracked asset (e.g. a vehicle under 'Other Assets'). Pass the asset id from list_assets and the new value in USD dollars. Preserves the asset's name/type/net-worth setting. Returns the updated asset.",
        inputSchema: {
            asset_id: z.string().describe("The asset node id (the `id` from list_assets)"),
            value: z.number().nonnegative().describe("The new asset value in USD dollars (e.g. 60000 for $60k)"),
        },
        annotations: WRITE,
    }, tool(async ({ asset_id, value }) => {
        const updated = await rm.updateAssetValue(asset_id, Math.round(value * 100));
        return {
            id: updated.assetId,
            name: updated.name,
            value: fmt.usd(updated.valueCents),
            type: updated.assetType,
            includeInNetWorth: updated.includeInNetWorth,
            ok: true,
        };
    }));
    return server;
}
