import { applySetCookies, loadSession, markSessionDead, saveSession, serializeJar, } from "./session.js";
import { monthWindows, ymd, addDays } from "./windows.js";
const GRAPHQL_URL = "https://client-api.rocketmoney.com/graphql";
// Captured from the web app. The exact value doesn't gate persisted-query
// resolution (hashes survive client-version bumps) but RM expects the header.
const WEB_CLIENT_VERSION = process.env.ROCKETMONEY_WEB_CLIENT_VERSION ?? "2fc82a9db6";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
// Persisted-query hashes captured from app.rocketmoney.com-2.har (2026-07-05).
// These are READ operations only. If RM rotates a hash the call returns
// PersistedQueryNotFound and the tool surfaces a clear "re-capture" error.
const PERSISTED = {
    AuthenticationCheck: "5fe578b1917c4601cb63948f580ad3bdadded0fefa985fdd2fe2d1b913cce2d0",
    RefreshAuthToken: "a86bd0f5e3fbc3673d1215b894362c5cd28ce060a7bb326cc9fd37b06bdd9fbb",
    SettingsAccountsPage: "9a2d400302623749fb664756a9cb6d2068c7b9d51e6608062785c60b834cb345",
    AccountDetailPage: "43d99c4074844dc1ec67f395e25ad0b5e5da7e60aba40d1dcd96cc162b64d634",
    NetWorthQuery: "5d319beb9e4b601c8381198731cbdaeeba106e442c44c049e4333142db07ed11",
    SpendingPage: "26e04b9b4bcf2033891037bda8b67e43afc96684f0d734883fa1af75776f14fa",
    Budgets: "f55267f5c1dacf4bfa2c92893506f771f49e3ddc04d34fa14d21d0ffeea4dfbe",
    RecurringPage: "1c6519edc695c49825a35112df49ffc275bec318736e364c5991dfef6a29430f",
    RecurringUpcomingPage: "f1dd34f01b69dd0367a8b20a07b8b45977ab6d1ce0d31919b1b4143e5ba205bc",
    TransactionCategoryPage: "1edf87cac5ca2a6428aeea4e35ae0521d0707f1e6e1fba6715ddc1d2a634fddf",
    TransactionsPageTransactionTable: "5bc74a0e8d2c33efe103eeb87d6ec09d9b57fb34795597ef2e3f7d892d76a056",
    // The user's full category catalog (default + custom), with node ids. Captured
    // from app.rocketmoney.com.har (2026-07-05). Read-only; rotating is handled the
    // same as any other persisted read (PersistedQueryNotFound -> re-capture).
    TransactionCategories: "b8734a0ec18579870ec0e707beca2a05450193c99e55df6f165be9d18a53e6b4",
};
/** Thrown when the session is no longer authenticated (cookie expired/revoked). */
export class RMAuthError extends Error {
}
// Relay global IDs are base64 of `Type:numericId`. RM already returns opaque
// base64 `id` fields on nodes, so we only need to BUILD ids when the caller
// passes a numeric id (e.g. a category number from another screen).
export function toNodeId(type, numericId) {
    return Buffer.from(`${type}:${numericId}`).toString("base64");
}
/** Inverse of toNodeId: decode a Relay node id into `{ type, numericId }`, or null. */
export function fromNodeId(nodeId) {
    try {
        const decoded = Buffer.from(nodeId, "base64").toString("utf8");
        const idx = decoded.indexOf(":");
        if (idx <= 0)
            return null;
        const type = decoded.slice(0, idx);
        const numericId = decoded.slice(idx + 1);
        // Round-trip guard: reject inputs that aren't really base64 node ids.
        if (!/^[A-Za-z]+$/.test(type) || toNodeId(type, numericId) !== nodeId)
            return null;
        return { type, numericId };
    }
    catch {
        return null;
    }
}
// Serialize every RM API call. The session cookie is a ROLLING token: each
// response rotates it (Set-Cookie), and we persist the rotated jar. Two calls in
// flight at once both send the same pre-rotation cookie; RM rotates it for the
// first and the second's copy is instantly stale -> 401 -> the whole session is
// marked dead. So a bot firing parallel tool calls (session_status + list_accounts
// + budgets) would knock itself offline. Chaining calls onto a single promise
// makes load-jar -> request -> save-jar atomic; concurrent callers just queue.
let rmChain = Promise.resolve();
/**
 * Core executor: POST a full GraphQL body with the live cookie jar, rotate the
 * jar from the response's Set-Cookie headers, and persist it. Throws
 * RMAuthError if the session is dead so callers can report "re-auth needed".
 * Serialized via rmChain so concurrent requests can't race the rolling cookie.
 */
function rmExecute(opName, payload) {
    const run = rmChain.then(() => rmExecuteUnlocked(opName, payload), () => rmExecuteUnlocked(opName, payload));
    // Keep the chain alive regardless of this call's outcome (swallow here only;
    // the real result/rejection still propagates to the caller via `run`).
    rmChain = run.then(() => undefined, () => undefined);
    return run;
}
async function rmExecuteUnlocked(opName, payload) {
    const jar = loadSession();
    if (!jar)
        throw new RMAuthError("No Rocket Money session. Paste a fresh cookie at /auth.");
    const res = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
            accept: "application/graphql+json, application/json",
            "content-type": "application/json",
            origin: "https://app.rocketmoney.com",
            referer: "https://app.rocketmoney.com/",
            "user-agent": USER_AGENT,
            "x-truebill-web-client-version": WEB_CLIENT_VERSION,
            cookie: serializeJar(jar),
        },
        body: JSON.stringify(payload),
        redirect: "manual",
    });
    if (res.status === 401 || res.status === 403 || res.status === 302) {
        markSessionDead(`HTTP ${res.status} on ${opName}`);
        throw new RMAuthError(`Rocket Money auth failed (HTTP ${res.status}). Re-auth at /auth.`);
    }
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    }
    catch {
        throw new Error(`RM ${opName}: non-JSON response (HTTP ${res.status})`);
    }
    if (json.errors?.length) {
        const authErr = json.errors.find((e) => e.extensions?.code === "UNAUTHENTICATED" ||
            /not? authenticated|unauthorized|session/i.test(e.message));
        if (authErr) {
            markSessionDead(`GraphQL: ${authErr.message}`);
            throw new RMAuthError(`Rocket Money auth failed: ${authErr.message}. Re-auth at /auth.`);
        }
        if (json.errors.some((e) => /PersistedQueryNotFound/i.test(e.message))) {
            throw new Error(`RM ${opName}: PersistedQueryNotFound - Rocket Money rotated this query hash; re-capture it from a fresh HAR and update PERSISTED in client.ts.`);
        }
        throw new Error(`RM ${opName}: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    // Healthy authenticated response - commit the rotated cookies.
    const setCookies = res.headers
        .getSetCookie?.();
    if (setCookies?.length)
        applySetCookies(jar, setCookies);
    saveSession(jar);
    return json.data;
}
/** Persisted-query READ (hash captured from a HAR; may rotate server-side). */
async function rmGraphQL(body) {
    return rmExecute(body.operationName, {
        operationName: body.operationName,
        variables: body.variables ?? {},
        extensions: { persistedQuery: { version: 1, sha256Hash: PERSISTED[body.operationName] } },
    });
}
/**
 * Full-text WRITE mutation. Sends the whole query string rather than a persisted
 * hash on purpose, so RM rotating a read hash can never break the write path.
 */
async function rmMutation(operationName, query, variables) {
    return rmExecute(operationName, { operationName, query, variables });
}
// ── Generic helpers ────────────────────────────────────────────────
/** Recursively find the first object with the given __typename. */
function findByType(obj, typename) {
    if (!obj || typeof obj !== "object")
        return null;
    const o = obj;
    if (o.__typename === typename)
        return o;
    for (const v of Object.values(o)) {
        const found = findByType(v, typename);
        if (found)
            return found;
    }
    return null;
}
/** Collect every object with the given __typename. */
function collectByType(obj, typename, out) {
    if (!obj || typeof obj !== "object")
        return;
    if (Array.isArray(obj)) {
        for (const el of obj)
            collectByType(el, typename, out);
        return;
    }
    const o = obj;
    if (o.__typename === typename)
        out.push(o);
    for (const v of Object.values(o))
        collectByType(v, typename, out);
}
function findPageInfo(obj) {
    if (!obj || typeof obj !== "object")
        return null;
    const o = obj;
    if (typeof o.hasNextPage === "boolean") {
        return { hasNextPage: o.hasNextPage, endCursor: o.endCursor ?? null };
    }
    for (const v of Object.values(o)) {
        const found = findPageInfo(v);
        if (found)
            return found;
    }
    return null;
}
// ── Operations ─────────────────────────────────────────────────────
/** Cheap liveness probe (also rotates the cookie). Returns viewer id if authed. */
export async function authenticationCheck() {
    const data = await rmGraphQL({ operationName: "AuthenticationCheck" });
    return data.viewer?.id ?? "";
}
/** Keepalive - re-rolls the session cookie. */
export async function refreshAuthToken() {
    await rmGraphQL({ operationName: "RefreshAuthToken" });
}
/** Every institution + account with current balance. */
export async function getAccounts() {
    return rmGraphQL({ operationName: "SettingsAccountsPage" });
}
/** One account's detail: balances, liabilities/APRs, 6-month balance history. */
export async function getAccountDetail(accountNodeId) {
    const w = monthWindows();
    return rmGraphQL({
        operationName: "AccountDetailPage",
        variables: {
            id: accountNodeId,
            sixMonthsAgo: w.sixMonthsAgo,
            currentMonthStart: w.currentMonthStart,
            nextMonthStart: w.nextMonthStart,
        },
    });
}
/** Net worth decomposed into cash/savings/investments/debts + history. */
export async function getNetWorth(useEquity = false) {
    const w = monthWindows();
    return rmGraphQL({
        operationName: "NetWorthQuery",
        variables: { sixMonthsAgo: w.sixMonthsAgo, useEquity, lastMonth: w.lastMonthEnd },
    });
}
/** This-month vs last-month spending, earnings, and per-category breakdown. */
export async function getSpending() {
    const w = monthWindows();
    return rmGraphQL({
        operationName: "SpendingPage",
        variables: {
            startOfCurrentTimePeriod: w.currentMonthStart,
            endOfCurrentTimePeriod: w.nextMonthStart,
            startOfPreviousTimePeriod: w.previousMonthStart,
            endOfPreviousTimePeriod: w.currentMonthStart,
            budgetPlanMonth: w.currentMonthStart,
            now: w.now,
            isCurrentMonth: true,
            isWeekly: false,
            isMonthly: true,
            transactionHistoryInterval: "month",
            transactionHistoryGteDate: ymd(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 5, 1))),
        },
    });
}
/** Budgets: earnings + spend for this and the prior three months. */
export async function getBudgets() {
    const w = monthWindows();
    const now = new Date();
    const startNMonths = (n) => ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1)));
    return rmGraphQL({
        operationName: "Budgets",
        variables: {
            startOfThisMonth: w.currentMonthStart,
            endOfThisMonth: w.nextMonthStart,
            startOfLastMonth: startNMonths(1),
            startOfTwoMonthsAgo: startNMonths(2),
            startOfThreeMonthsAgo: startNMonths(3),
        },
    });
}
/** Recurring charges / subscriptions with next-charge estimates. */
export async function getRecurring() {
    const w = monthWindows();
    return rmGraphQL({
        operationName: "RecurringPage",
        variables: { transactionHistoryGteDate: w.sixMonthsAgo },
    });
}
/** Upcoming bill/subscription charges in the next `days` days (default 28). */
export async function getUpcoming(days = 28) {
    const now = new Date();
    return rmGraphQL({
        operationName: "RecurringUpcomingPage",
        variables: { upcomingStartDate: ymd(now), upcomingEndDate: ymd(addDays(now, days)) },
    });
}
/** Transactions inside one category for the current month. */
export async function getCategoryTransactions(categoryNodeId, pageSize = 200) {
    const w = monthWindows();
    return rmGraphQL({
        operationName: "TransactionCategoryPage",
        variables: {
            id: categoryNodeId,
            pageSize,
            startOfCurrentTimePeriod: w.currentMonthStart,
            endOfCurrentTimePeriod: w.nextMonthStart,
            transactionCategoryNodeId: categoryNodeId,
        },
    });
}
/**
 * Search transactions matching `query` (optional) on/after `gteDate`
 * (YYYY-MM-DD, optional). Paginates up to a safety cap and dedupes.
 */
export async function searchTransactions(query, gteDate, maxPages = 6) {
    const all = [];
    let cursor = null;
    for (let page = 0; page < maxPages; page++) {
        const data = await rmGraphQL({
            operationName: "TransactionsPageTransactionTable",
            variables: {
                query,
                order: "reverse:date",
                accountIds: [],
                transactionCategoryIds: [],
                gteDate,
                ltDate: null,
                cursor,
                pageSize: 200,
                metaCategory: null,
            },
        });
        const nodes = [];
        collectByType(data, "Transaction", nodes);
        const before = all.length;
        for (const o of nodes) {
            if (typeof o.id !== "string" || typeof o.amount !== "number")
                continue;
            const category = o.category;
            all.push({
                nodeId: o.id,
                amountCents: o.amount,
                date: String(o.date ?? ""),
                note: o.note ?? null,
                name: String(o.longName ?? o.shortName ?? ""),
                categoryLabel: category?.label ?? null,
            });
        }
        const pageInfo = findPageInfo(data);
        if (!pageInfo?.hasNextPage || !pageInfo.endCursor || all.length === before)
            break;
        cursor = pageInfo.endCursor;
    }
    const seen = new Set();
    return all.filter((t) => (seen.has(t.nodeId) ? false : (seen.add(t.nodeId), true)));
}
/** base64(`TransactionCategory:<id>`) for a numeric category id. */
export function categoryNodeId(numericId) {
    return toNodeId("TransactionCategory", numericId);
}
/** READ: the user's full category catalog (default + custom), with node ids. */
export async function getTransactionCategories() {
    const data = await rmGraphQL({ operationName: "TransactionCategories" });
    const nodes = [];
    collectByType(data, "TransactionCategory", nodes);
    const seen = new Set();
    const cats = [];
    for (const o of nodes) {
        const nodeId = typeof o.id === "string" ? o.id : "";
        if (!nodeId || seen.has(nodeId))
            continue;
        seen.add(nodeId);
        cats.push({
            nodeId,
            id: fromNodeId(nodeId)?.numericId ?? "",
            label: String(o.label ?? ""),
            type: String(o.type ?? ""),
            categoryType: String(o.categoryType ?? ""),
            includeInSpending: Boolean(o.includeInSpending),
            includeInEarnings: Boolean(o.includeInEarnings),
            taxDeductible: Boolean(o.taxDeductible),
        });
    }
    return cats.sort((a, b) => a.label.localeCompare(b.label));
}
// Per-process memo of the category catalog. Categories change rarely and the Fly
// machine stays warm, so caching spares a round-trip on every label resolution.
let _catCache = null;
const CAT_TTL_MS = 10 * 60 * 1000;
async function categoriesCached() {
    if (_catCache && Date.now() - _catCache.at < CAT_TTL_MS)
        return _catCache.cats;
    const cats = await getTransactionCategories();
    _catCache = { at: Date.now(), cats };
    return cats;
}
/**
 * Resolve a caller-supplied category (a label like "Groceries", a numeric id, or
 * a base64 TransactionCategory node id) to a node id. Throws a clear, actionable
 * error listing valid labels when a label doesn't match.
 */
export async function resolveCategoryNodeId(input) {
    const raw = String(input).trim();
    // Already a TransactionCategory node id?
    if (fromNodeId(raw)?.type === "TransactionCategory")
        return raw;
    // Bare numeric id -> build the node id (no lookup needed).
    if (/^\d+$/.test(raw))
        return categoryNodeId(raw);
    // Otherwise treat it as a label and look it up (case-insensitive).
    const cats = await categoriesCached();
    const match = cats.find((c) => c.label.toLowerCase() === raw.toLowerCase());
    if (match)
        return match.nodeId;
    throw new Error(`Unknown category "${raw}". Use list_categories to see valid options. Available: ${cats
        .map((c) => c.label)
        .join(", ")}`);
}
/** WRITE: set (or clear, with "") a transaction's free-text note. Returns the saved note. */
export async function setTransactionNote(nodeId, note) {
    const data = await rmMutation("SetTransactionNote", "mutation SetTransactionNote($input: SetTransactionNoteInput!) {\n  setTransactionNote(input: $input) {\n    __typename\n    transaction {\n      __typename\n      id\n      note\n    }\n  }\n}", { input: { transactionNodeId: nodeId, note } });
    return data.setTransactionNote?.transaction?.note ?? note;
}
/**
 * WRITE: set a transaction's spending category. `catNodeId` must be a
 * TransactionCategory node id (use resolveCategoryNodeId to accept labels/ids).
 * When `applyToAll` is true, RM re-categorizes every related transaction from the
 * same merchant, not just this one.
 */
export async function setTransactionCategory(nodeId, catNodeId, applyToAll = false) {
    const data = await rmMutation("SetTransactionCategory", "mutation SetTransactionCategory($input: SetTransactionCategoryInput!) {\n  setTransactionCategory(input: $input) {\n    __typename\n    updatedTransactions {\n      id\n      __typename\n    }\n  }\n}", {
        input: {
            transactionNodeId: nodeId,
            transactionCategoryNodeId: catNodeId,
            categorizeAllRelatedTransactions: applyToAll,
        },
    });
    return data.setTransactionCategory?.updatedTransactions?.length ?? 0;
}
export { findByType, collectByType };
