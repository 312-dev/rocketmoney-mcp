import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Amazon-sync state lives next to the session jar on the Fly volume, so the
// idempotency map and scheduler flag survive gateway redeploys.
function stateDir() {
    return process.env.ROCKETMONEY_STATE_DIR ?? "/data/rocketmoney";
}
export function readJson(name, fallback) {
    try {
        return JSON.parse(readFileSync(join(stateDir(), name), "utf8"));
    }
    catch {
        return fallback;
    }
}
export function writeJson(name, data) {
    const dir = stateDir();
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `${JSON.stringify(data, null, 2)}\n`);
}
