// Rocket Money MCP Sync - service worker
//
// Reads the rolling `tb.auth0.sid` session cookie from your logged-in Rocket
// Money browser session and pushes it to the MCP server's /auth/ingest endpoint,
// so the server's session stays in lockstep with your browser. It re-pushes
// whenever the cookie rotates (chrome.cookies.onChanged) and on a periodic alarm
// as a heartbeat / catch-up after the worker was suspended.

const API_HOST = "client-api.rocketmoney.com"; // cookies actually sent to the GraphQL API
const SID = "tb.auth0.sid";
const ALARM = "rm-sync";
const HEARTBEAT_MIN = 10; // periodic re-push
const DEBOUNCE_MS = 2500; // coalesce cookie-change bursts

// ---- config (options page) ----
async function getConfig() {
  const c = await chrome.storage.local.get(["ingestUrl", "clientId", "clientSecret"]);
  return {
    ingestUrl: c.ingestUrl || "https://rocketmoney-auth.graysons.network/auth/ingest",
    clientId: c.clientId || "",
    clientSecret: c.clientSecret || "",
  };
}

// ---- status the popup reads ----
async function setStatus(patch) {
  const prev = (await chrome.storage.local.get("status")).status || {};
  await chrome.storage.local.set({ status: { ...prev, ...patch, at: new Date().toISOString() } });
}
function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

// ---- read the cookie jar the API would receive ----
async function readCookieHeader() {
  let cookies = await chrome.cookies.getAll({ url: `https://${API_HOST}/` });
  let sid = cookies.find((c) => c.name === SID);
  if (!sid) {
    // Fallback: scan the whole rocketmoney.com cookie space.
    const all = await chrome.cookies.getAll({ domain: "rocketmoney.com" });
    sid = all.find((c) => c.name === SID);
    if (sid) cookies = all;
  }
  if (!sid || !sid.value) return null;
  return cookies.filter((c) => c.value).map((c) => `${c.name}=${c.value}`).join("; ");
}

// ---- push to the MCP server ----
let pushing = false;
async function push(reason) {
  if (pushing) return;
  pushing = true;
  try {
    const { ingestUrl, clientId, clientSecret } = await getConfig();
    if (!clientId || !clientSecret) {
      setBadge("cfg", "#cf222e");
      await setStatus({ ok: false, reason, message: "Not configured - open the extension options." });
      return;
    }
    const header = await readCookieHeader();
    if (!header) {
      setBadge("out", "#8a8a8a");
      await setStatus({ ok: false, reason, loggedIn: false, message: "Not logged into Rocket Money in this browser." });
      return;
    }
    const res = await fetch(ingestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Access-Client-Id": clientId,
        "CF-Access-Client-Secret": clientSecret,
      },
      body: JSON.stringify({ cookie: header }),
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      setBadge("ok", "#1a7f37");
      await setStatus({ ok: true, reason, loggedIn: true, server: body.status || "live", message: "Synced." });
    } else {
      const hint = res.status === 403 ? "403 - check the Access service token in options." : `HTTP ${res.status}`;
      setBadge("err", "#cf222e");
      await setStatus({ ok: false, reason, loggedIn: true, message: hint });
    }
  } catch (e) {
    setBadge("err", "#cf222e");
    await setStatus({ ok: false, reason, message: String(e && e.message ? e.message : e) });
  } finally {
    pushing = false;
  }
}

// ---- debounce cookie-change storms via a short one-shot alarm ----
function scheduleDebounced() {
  chrome.alarms.create("rm-debounce", { when: Date.now() + DEBOUNCE_MS });
}

// ---- wiring ----
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
  chrome.alarms.create(ALARM, { periodInMinutes: HEARTBEAT_MIN });
  push("installed");
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: HEARTBEAT_MIN });
  push("startup");
});

chrome.cookies.onChanged.addListener((info) => {
  if (info.cookie.name !== SID) return;
  if (!info.cookie.domain.includes("rocketmoney.com")) return;
  if (info.removed && info.cause !== "overwrite") {
    // logout / expiry - the browser session is gone; nothing to push.
    setBadge("out", "#8a8a8a");
    setStatus({ ok: false, loggedIn: false, message: "Rocket Money cookie removed (logged out)." });
    return;
  }
  scheduleDebounced(); // rotation (set/overwrite) -> push shortly
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) push("heartbeat");
  else if (a.name === "rm-debounce") push("rotation");
});

// Manual trigger from popup/options.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "push") {
    push("manual").then(() => sendResponse({ done: true }));
    return true; // async response
  }
});
