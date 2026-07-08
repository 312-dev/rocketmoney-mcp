import { JamClient } from "jmap-jam";
// jmap-jam's request typings are awkward under strict tsc; treat the instance as
// loose and lean on the shapes we actually read.
let _client = null;
function getClient() {
    if (!_client) {
        const token = process.env.FASTMAIL_TOKEN || "";
        if (!token)
            throw new Error("FASTMAIL_TOKEN required for Amazon enrichment");
        _client = new JamClient({ bearerToken: token, sessionUrl: "https://api.fastmail.com/jmap/session" });
    }
    return _client;
}
/** Ids of the Trash + Junk role mailboxes (so we can query them explicitly). */
async function specialMailboxIds(client, accountId) {
    try {
        const [res] = await client.request(["Mailbox/get", { accountId, properties: ["id", "role"] }]);
        const list = (res.list ?? []);
        return list.filter((m) => m.role === "trash" || m.role === "junk").map((m) => m.id);
    }
    catch {
        return [];
    }
}
async function queryIds(client, accountId, sinceISO, limit, inMailbox) {
    const conditions = [
        { after: sinceISO },
        { from: "auto-confirm@amazon.com" },
    ];
    if (inMailbox)
        conditions.push({ inMailbox });
    const [q] = await client.request([
        "Email/query",
        {
            accountId,
            filter: { operator: "AND", conditions },
            sort: [{ property: "receivedAt", isAscending: false }],
            limit,
        },
    ]);
    return (q.ids ?? []);
}
async function fetchOrders(sinceISO, limit) {
    const client = getClient();
    const accountId = await client.getPrimaryAccount();
    // Default scope (Inbox + Archive) plus an explicit Trash/Junk sweep, unioned.
    const idSet = new Set(await queryIds(client, accountId, sinceISO, limit));
    for (const mb of await specialMailboxIds(client, accountId)) {
        for (const id of await queryIds(client, accountId, sinceISO, limit, mb))
            idSet.add(id);
    }
    const ids = [...idSet];
    if (ids.length === 0)
        return [];
    const [emailData] = await client.request([
        "Email/get",
        {
            accountId,
            ids,
            properties: ["id", "subject", "receivedAt", "bodyValues", "textBody"],
            fetchTextBodyValues: true,
            maxBodyValueBytes: 5000,
        },
    ]);
    const orders = [];
    const emails = (emailData.list ?? []);
    for (const email of emails) {
        const date = String(email.receivedAt ?? "").split("T")[0] || "";
        const subject = String(email.subject ?? "");
        const itemMatch = subject.match(/Ordered: "(.+?)"/);
        if (!itemMatch)
            continue;
        const itemName = itemMatch[1];
        let bodyText = "";
        const bodyValues = email.bodyValues;
        if (bodyValues)
            for (const val of Object.values(bodyValues))
                if (val.value)
                    bodyText += val.value;
        let orderTotal = null;
        const patterns = [
            /Order Total:\s*\$?([\d,]+\.\d{2})/i,
            /Grand Total:\s*\$?([\d,]+\.\d{2})/i,
            /Item Subtotal:\s*\$?([\d,]+\.\d{2})/i,
        ];
        for (const pattern of patterns) {
            const m = bodyText.match(pattern);
            if (m) {
                orderTotal = Number.parseFloat(m[1].replace(",", ""));
                break;
            }
        }
        orders.push({ date, itemName, orderTotal });
    }
    return orders;
}
/** All Amazon orders confirmed on/after `sinceISO` (across Inbox/Archive/Trash/Junk). */
export async function fetchAmazonOrdersSince(sinceISO) {
    if (!process.env.FASTMAIL_TOKEN)
        return [];
    try {
        return await fetchOrders(sinceISO, 500);
    }
    catch (err) {
        console.error("[amazon] failed to fetch orders since", sinceISO, err);
        return [];
    }
}
/** Whether a merchant name looks like Amazon. */
export function isAmazonCharge(merchant) {
    const lower = merchant.toLowerCase();
    return lower.includes("amazon") || lower.includes("amzn");
}
