const $ = (id) => document.getElementById(id);

function fmt(iso) {
  if (!iso) return "never";
  const d = new Date(iso);
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return d.toLocaleString();
}

async function render() {
  const { status } = await chrome.storage.local.get("status");
  const cfg = await chrome.storage.local.get(["clientId", "clientSecret"]);
  const configured = cfg.clientId && cfg.clientSecret;

  if (!configured) {
    $("server").textContent = "not configured";
    $("serverDot").className = "dot bad";
    $("msg").textContent = "Set the Access service token in Options.";
    return;
  }
  const s = status || {};
  $("server").textContent = s.server || (s.ok ? "live" : "unknown");
  $("serverDot").className = "dot " + (s.ok ? "live" : "bad");
  $("login").textContent = s.loggedIn === false ? "logged out" : s.loggedIn ? "logged in" : "unknown";
  $("loginDot").className = "dot " + (s.loggedIn === false ? "bad" : s.loggedIn ? "live" : "idle");
  $("last").textContent = fmt(s.at);
  $("msg").textContent = s.message || "";
}

$("sync").addEventListener("click", async () => {
  $("msg").textContent = "Syncing…";
  await chrome.runtime.sendMessage({ type: "push" }).catch(() => null);
  render();
});
$("opts").addEventListener("click", () => chrome.runtime.openOptionsPage());

render();
