const $ = (id) => document.getElementById(id);
const DEFAULT_URL = "https://rocketmoney-auth.graysons.network/auth/ingest";

async function load() {
  const c = await chrome.storage.local.get(["ingestUrl", "clientId", "clientSecret"]);
  $("ingestUrl").value = c.ingestUrl || DEFAULT_URL;
  $("clientId").value = c.clientId || "";
  $("clientSecret").value = c.clientSecret || "";
}

async function save() {
  const ingestUrl = $("ingestUrl").value.trim() || DEFAULT_URL;
  await chrome.storage.local.set({
    ingestUrl,
    clientId: $("clientId").value.trim(),
    clientSecret: $("clientSecret").value.trim(),
  });
}

function msg(text, cls) {
  const el = $("msg");
  el.textContent = text;
  el.className = cls || "";
}

$("save").addEventListener("click", async () => {
  await save();
  msg("Saved.", "ok");
});

$("test").addEventListener("click", async () => {
  await save();
  msg("Syncing…");
  await chrome.runtime.sendMessage({ type: "push" }).catch(() => null);
  const { status } = await chrome.storage.local.get("status");
  if (status && status.ok) msg(`Synced. Server session: ${status.server || "live"}.`, "ok");
  else msg(status ? `Failed: ${status.message}` : "No response from background worker.", "bad");
});

load();
