/**
 * Loads the bundled Worker script source from the package.
 *
 * The script ships next to the compiled JS at `dist/worker.js`
 * (copied from `src/worker.js` by the build step).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export function loadBundledWorker(): string {
  return readFileSync(join(here, "worker.js"), "utf8");
}

/** Default Worker script name used when the caller doesn't override. */
export const DEFAULT_WORKER_NAME = "filecoin-nova-gateway";

/** Default KV namespace title. */
export const DEFAULT_KV_TITLE = "filecoin-nova-gateway-kv";

/** Default Workers compatibility date. */
export const DEFAULT_COMPAT_DATE = "2026-04-01";
