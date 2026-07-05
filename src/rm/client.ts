import {
  applySetCookies,
  loadSession,
  markSessionDead,
  saveSession,
  serializeJar,
} from "./session.js";
import { monthWindows, ymd, addDays } from "./windows.js";

const GRAPHQL_URL = "https://client-api.rocketmoney.com/graphql";
// Captured from the web app. The exact value doesn't gate persisted-query
// resolution (hashes survive client-version bumps) but RM expects the header.
const WEB_CLIENT_VERSION = process.env.ROCKETMONEY_WEB_CLIENT_VERSION ?? "2fc82a9db6";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

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
  TransactionsPageTransactionTable:
    "5bc74a0e8d2c33efe103eeb87d6ec09d9b57fb34795597ef2e3f7d892d76a056",
} as const;

/** Thrown when the session is no longer authenticated (cookie expired/revoked). */
export class RMAuthError extends Error {}

// Relay global IDs are base64 of `Type:numericId`. RM already returns opaque
// base64 `id` fields on nodes, so we only need to BUILD ids when the caller
// passes a numeric id (e.g. a category number from another screen).
export function toNodeId(type: string, numericId: string | number): string {
  return Buffer.from(`${type}:${numericId}`).toString("base64");
}

interface GraphQLBody {
  operationName: keyof typeof PERSISTED;
  variables?: Record<string, unknown>;
}

/**
 * Execute one persisted-query GraphQL request with the live cookie jar, rotate
 * the jar from the response's Set-Cookie headers, and persist it. Throws
 * RMAuthError if the session is dead so callers can report "re-auth needed".
 */
async function rmGraphQL<T = unknown>(body: GraphQLBody): Promise<T> {
  const jar = loadSession();
  if (!jar) throw new RMAuthError("No Rocket Money session. Paste a fresh cookie at /auth.");

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
    body: JSON.stringify({
      operationName: body.operationName,
      variables: body.variables ?? {},
      extensions: { persistedQuery: { version: 1, sha256Hash: PERSISTED[body.operationName] } },
    }),
    redirect: "manual",
  });

  if (res.status === 401 || res.status === 403 || res.status === 302) {
    markSessionDead(`HTTP ${res.status} on ${body.operationName}`);
    throw new RMAuthError(`Rocket Money auth failed (HTTP ${res.status}). Re-auth at /auth.`);
  }

  const text = await res.text();
  let json: {
    data?: T;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`RM ${body.operationName}: non-JSON response (HTTP ${res.status})`);
  }

  if (json.errors?.length) {
    const authErr = json.errors.find(
      (e) =>
        e.extensions?.code === "UNAUTHENTICATED" ||
        /not? authenticated|unauthorized|session/i.test(e.message),
    );
    if (authErr) {
      markSessionDead(`GraphQL: ${authErr.message}`);
      throw new RMAuthError(`Rocket Money auth failed: ${authErr.message}. Re-auth at /auth.`);
    }
    if (json.errors.some((e) => /PersistedQueryNotFound/i.test(e.message))) {
      throw new Error(
        `RM ${body.operationName}: PersistedQueryNotFound - Rocket Money rotated this query hash; re-capture it from a fresh HAR and update PERSISTED in client.ts.`,
      );
    }
    throw new Error(`RM ${body.operationName}: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  // Healthy authenticated response - commit the rotated cookies.
  const setCookies = (res as unknown as { headers: { getSetCookie?: () => string[] } }).headers
    .getSetCookie?.();
  if (setCookies?.length) applySetCookies(jar, setCookies);
  saveSession(jar);

  return json.data as T;
}

// ── Generic helpers ────────────────────────────────────────────────

/** Recursively find the first object with the given __typename. */
function findByType(obj: unknown, typename: string): Record<string, unknown> | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.__typename === typename) return o;
  for (const v of Object.values(o)) {
    const found = findByType(v, typename);
    if (found) return found;
  }
  return null;
}

/** Collect every object with the given __typename. */
function collectByType(obj: unknown, typename: string, out: Record<string, unknown>[]): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const el of obj) collectByType(el, typename, out);
    return;
  }
  const o = obj as Record<string, unknown>;
  if (o.__typename === typename) out.push(o);
  for (const v of Object.values(o)) collectByType(v, typename, out);
}

function findPageInfo(obj: unknown): { hasNextPage: boolean; endCursor: string | null } | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.hasNextPage === "boolean") {
    return { hasNextPage: o.hasNextPage, endCursor: (o.endCursor as string) ?? null };
  }
  for (const v of Object.values(o)) {
    const found = findPageInfo(v);
    if (found) return found;
  }
  return null;
}

// ── Operations ─────────────────────────────────────────────────────

/** Cheap liveness probe (also rotates the cookie). Returns viewer id if authed. */
export async function authenticationCheck(): Promise<string> {
  const data = await rmGraphQL<{ viewer?: { id?: string } }>({ operationName: "AuthenticationCheck" });
  return data.viewer?.id ?? "";
}

/** Keepalive - re-rolls the session cookie. */
export async function refreshAuthToken(): Promise<void> {
  await rmGraphQL({ operationName: "RefreshAuthToken" });
}

/** Every institution + account with current balance. */
export async function getAccounts(): Promise<Record<string, unknown>> {
  return rmGraphQL({ operationName: "SettingsAccountsPage" });
}

/** One account's detail: balances, liabilities/APRs, 6-month balance history. */
export async function getAccountDetail(accountNodeId: string): Promise<Record<string, unknown>> {
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
export async function getNetWorth(useEquity = false): Promise<Record<string, unknown>> {
  const w = monthWindows();
  return rmGraphQL({
    operationName: "NetWorthQuery",
    variables: { sixMonthsAgo: w.sixMonthsAgo, useEquity, lastMonth: w.lastMonthEnd },
  });
}

/** This-month vs last-month spending, earnings, and per-category breakdown. */
export async function getSpending(): Promise<Record<string, unknown>> {
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
export async function getBudgets(): Promise<Record<string, unknown>> {
  const w = monthWindows();
  const now = new Date();
  const startNMonths = (n: number) =>
    ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1)));
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
export async function getRecurring(): Promise<Record<string, unknown>> {
  const w = monthWindows();
  return rmGraphQL({
    operationName: "RecurringPage",
    variables: { transactionHistoryGteDate: w.sixMonthsAgo },
  });
}

/** Upcoming bill/subscription charges in the next `days` days (default 28). */
export async function getUpcoming(days = 28): Promise<Record<string, unknown>> {
  const now = new Date();
  return rmGraphQL({
    operationName: "RecurringUpcomingPage",
    variables: { upcomingStartDate: ymd(now), upcomingEndDate: ymd(addDays(now, days)) },
  });
}

/** Transactions inside one category for the current month. */
export async function getCategoryTransactions(
  categoryNodeId: string,
  pageSize = 200,
): Promise<Record<string, unknown>> {
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

export interface RMTransaction {
  nodeId: string;
  amountCents: number;
  date: string;
  note: string | null;
  name: string;
  categoryLabel: string | null;
}

/**
 * Search transactions matching `query` (optional) on/after `gteDate`
 * (YYYY-MM-DD, optional). Paginates up to a safety cap and dedupes.
 */
export async function searchTransactions(
  query: string | null,
  gteDate: string | null,
  maxPages = 6,
): Promise<RMTransaction[]> {
  const all: RMTransaction[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const data = await rmGraphQL<Record<string, unknown>>({
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

    const nodes: Record<string, unknown>[] = [];
    collectByType(data, "Transaction", nodes);
    const before = all.length;
    for (const o of nodes) {
      if (typeof o.id !== "string" || typeof o.amount !== "number") continue;
      const category = o.category as { label?: string } | null | undefined;
      all.push({
        nodeId: o.id,
        amountCents: o.amount,
        date: String(o.date ?? ""),
        note: (o.note as string | null) ?? null,
        name: String(o.longName ?? o.shortName ?? ""),
        categoryLabel: category?.label ?? null,
      });
    }

    const pageInfo = findPageInfo(data);
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor || all.length === before) break;
    cursor = pageInfo.endCursor;
  }

  const seen = new Set<string>();
  return all.filter((t) => (seen.has(t.nodeId) ? false : (seen.add(t.nodeId), true)));
}

export { findByType, collectByType };
