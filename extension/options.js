const $ = (id) => document.getElementById(id);

async function load() {
  const c = await chrome.storage.local.get(["ingestUrl", "clientId", "clientSecret"]);
  $("ingestUrl").value = c.ingestUrl || "";
  $("clientId").value = c.clientId || "";
  $("clientSecret").value = c.clientSecret || "";
}

// Only https, or plain http to the local machine, may receive the cookie jar.
function parseIngestUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("Ingest URL is not a valid URL."); }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
    throw new Error("Ingest URL must be https:// (or http://localhost).");
  return u;
}

async function save() {
  const ingestUrl = $("ingestUrl").value.trim();
  if (!ingestUrl) throw new Error("Set the ingest URL of your own server first.");
  const u = parseIngestUrl(ingestUrl);
  // Host permission is granted per server, at save time, rather than baked into the manifest.
  const origin = `${u.origin}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error(`Permission to contact ${u.origin} was not granted.`);
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
  try { await save(); } catch (e) { return msg(e.message, "bad"); }
  msg("Saved.", "ok");
});

$("test").addEventListener("click", async () => {
  try { await save(); } catch (e) { return msg(e.message, "bad"); }
  msg("Syncing…");
  await chrome.runtime.sendMessage({ type: "push" }).catch(() => null);
  const { status } = await chrome.storage.local.get("status");
  if (status && status.ok) msg(`Synced. Server session: ${status.server || "live"}.`, "ok");
  else msg(status ? `Failed: ${status.message}` : "No response from background worker.", "bad");
});

load();
