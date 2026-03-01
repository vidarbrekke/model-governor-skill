import path from "node:path";
import type { Policy } from "./types.js";

/**
 * Resolve the governor JSONL log file path in a way that works across instances:
 * - ROUTER_GOVERNOR_LOG_PATH (env): use as-is; resolved to absolute if relative.
 * - OPENCLAW_HOME (env): use <OPENCLAW_HOME>/logs/model-governor.jsonl (absolute per instance).
 * - Otherwise: policy.logging.path (or default) relative to process.cwd().
 */
export function resolveGovernorLogPath(
  policy: Policy,
  overrides?: { explicitLogPath?: string }
): string {
  const cwd = process.cwd();

  if (overrides?.explicitLogPath) {
    return path.resolve(cwd, overrides.explicitLogPath);
  }

  const envPath = process.env.ROUTER_GOVERNOR_LOG_PATH;
  if (envPath) {
    return path.resolve(cwd, envPath);
  }

  const openclawHome = process.env.OPENCLAW_HOME;
  if (openclawHome) {
    return path.join(path.resolve(openclawHome), "logs", "model-governor.jsonl");
  }

  const configured = policy.logging.path ?? ".openclaw/logs/model-governor.jsonl";
  return path.isAbsolute(configured) ? configured : path.join(cwd, configured);
}
