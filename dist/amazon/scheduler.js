import { sessionStatus } from "../rm/session.js";
import { readJson, writeJson } from "./state.js";
import { sinceFromLookback, syncAmazonSince } from "./sync.js";
// Persisted scheduler flag on the Fly volume. The background loop reads it every
// tick, so amazon_sync_enable/disable take effect without a redeploy. Default is
// DISABLED - autonomous writes are strictly opt-in via the MCP tool.
const CONFIG_FILE = "amazon-scheduler.json";
const DEFAULTS = {
    enabled: false,
    intervalHours: 6,
    lookbackDays: 10,
    lastRunAt: null,
    lastSummary: null,
};
export function getSchedulerConfig() {
    return { ...DEFAULTS, ...readJson(CONFIG_FILE, {}) };
}
export function setSchedulerConfig(patch) {
    const next = { ...getSchedulerConfig(), ...patch };
    writeJson(CONFIG_FILE, next);
    return next;
}
let running = false;
async function tick() {
    if (running)
        return;
    const cfg = getSchedulerConfig();
    if (!cfg.enabled)
        return;
    if (sessionStatus().status !== "live")
        return; // wait for a live cookie (extension keeps it fresh)
    const dueMs = cfg.intervalHours * 3_600_000;
    if (cfg.lastRunAt && Date.now() - new Date(cfg.lastRunAt).getTime() < dueMs)
        return;
    running = true;
    try {
        const summary = await syncAmazonSince(sinceFromLookback(cfg.lookbackDays), false);
        setSchedulerConfig({ lastRunAt: new Date().toISOString(), lastSummary: summary });
        console.log(`[amazon-scheduler] ran: ${summary.updated} updated, ${summary.skipped} skipped, ${summary.unmatched} unmatched`);
    }
    catch (err) {
        console.warn("[amazon-scheduler] run failed:", err instanceof Error ? err.message : String(err));
    }
    finally {
        running = false;
    }
}
/** Start the background scheduler: check every 15 min, run when enabled + due. */
export function startAmazonScheduler() {
    setInterval(() => void tick(), 15 * 60_000).unref();
    setTimeout(() => void tick(), 30_000).unref(); // an early check after boot
    console.log("[amazon-scheduler] started (checks every 15m; runs when enabled + due)");
}
/** Run one sync immediately, on demand (backs the run/preview/apply tools). */
export async function runNow(dryRun, lookbackDays) {
    const cfg = getSchedulerConfig();
    const summary = await syncAmazonSince(sinceFromLookback(lookbackDays ?? cfg.lookbackDays), dryRun);
    if (!dryRun)
        setSchedulerConfig({ lastRunAt: new Date().toISOString(), lastSummary: summary });
    return summary;
}
