// Account, balance and spending reads, plus manual asset values.
import { z } from "zod";
import { READ, WRITE, AUTH_HINT, READ_ONLY, tool } from "./common.js";
import * as rm from "../rm/client.js";
import * as fmt from "../rm/format.js";
import { sessionStatus } from "../rm/session.js";
/**
 * Linked institutions that stopped syncing, each account dated by its newest transaction.
 * A disconnected card silently drops its charges from every search, so session_status
 * reports them up front.
 */
export async function staleConnectionsNow({ getAccounts = rm.getAccounts, lastDate = async (accountId) => (await rm.searchTransactionsPage({ accountIds: [accountId], limit: 1 })).transactions[0]?.date ?? null, } = {}) {
    return fmt.withLastTransaction(fmt.staleConnections(fmt.shapeAccounts(await getAccounts())), lastDate);
}
export function registerAccountsTools(server, writes) {
    server.registerTool("session_status", {
        title: "Session status",
        description: "Check whether the Rocket Money session is currently authenticated, and list linked institutions that stopped syncing (stale_connections, with each account's last transaction date: nothing after it is visible until it's reconnected in the Rocket Money app). Use this first if other tools report auth errors, and before categorizing or matching charges.",
        inputSchema: {},
        annotations: READ,
    }, tool(async () => {
        const local = sessionStatus();
        if (local.status !== "live")
            return { ...local, authenticated: false, readOnly: READ_ONLY, hint: AUTH_HINT };
        // Confirm liveness against RM (also rotates the cookie).
        const viewerId = await rm.authenticationCheck();
        const stale_connections = await staleConnectionsNow();
        return { ...local, authenticated: Boolean(viewerId), readOnly: READ_ONLY, stale_connections };
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
        return { count: holdings.length, totalValue: fmt.roundUsd(total), holdings };
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
    server.registerTool("upcoming_bills", {
        title: "Upcoming bills",
        description: "Upcoming subscription/bill charges in the next N days (default 28), with dates, amounts, and a total.",
        inputSchema: {
            days: z.number().int().min(1).max(90).optional().describe("Look-ahead window in days (default 28)"),
        },
        annotations: READ,
    }, tool(async ({ days }) => fmt.shapeUpcoming(await rm.getUpcoming(days ?? 28))));
    if (!writes)
        return;
    server.registerTool("set_asset_value", {
        title: "Set manual asset value",
        description: "WRITES to Rocket Money: update the value/balance of a manually-tracked asset (e.g. a vehicle under 'Other Assets'). Pass the asset id from list_assets and the new value in USD dollars. Preserves the asset's name/type/net-worth setting. Returns the updated asset.",
        inputSchema: {
            asset_id: z.string().describe("The asset node id (the `id` from list_assets)"),
            value: z.number().nonnegative().describe("The new asset value in USD dollars (e.g. 60000 for $60k)"),
        },
        annotations: WRITE,
    }, tool(async ({ asset_id, value }) => {
        const updated = await rm.updateAssetValue(asset_id, fmt.toCents(value));
        return {
            id: updated.assetId,
            name: updated.name,
            value: fmt.usd(updated.valueCents),
            type: updated.assetType,
            includeInNetWorth: updated.includeInNetWorth,
            ok: true,
        };
    }));
}
