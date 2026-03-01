#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { loadPolicy } from "./policy.js";

type LogEntry = {
  timestamp?: string;
  chosen_alias?: string;
  intent?: string;
  reason_codes?: string[];
  signals?: string[];
};

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function resolveLogPath(policyPath?: string): string {
  const policy = loadPolicy(policyPath);
  const envPath = process.env.ROUTER_GOVERNOR_LOG_PATH;
  const configured = envPath ?? policy.logging.path ?? ".openclaw/logs/model-governor.jsonl";
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function toDateMs(v?: string): number | null {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function main(): void {
  const hours = Number.parseInt(getArg("--hours") ?? "24", 10);
  const policyPath = getArg("--policy");
  const logPath = getArg("--log-path") ?? resolveLogPath(policyPath);

  if (!fs.existsSync(logPath)) {
    console.log(JSON.stringify({ ok: false, message: "log file not found", logPath }));
    process.exit(0);
  }

  const now = Date.now();
  const cutoff = now - hours * 60 * 60 * 1000;
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);

  const aliasCounts = new Map<string, number>();
  const reasonCounts = new Map<string, number>();
  const intentCounts = new Map<string, number>();
  const signalCounts = new Map<string, number>();
  const recent: Array<{
    timestamp?: string;
    chosen_alias?: string;
    intent?: string;
    reason_codes?: string[];
    signals?: string[];
  }> = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as LogEntry;
      const t = toDateMs(entry.timestamp);
      if (t !== null && t < cutoff) continue;

      if (entry.chosen_alias) bump(aliasCounts, entry.chosen_alias);
      if (entry.intent) bump(intentCounts, entry.intent);
      for (const r of entry.reason_codes ?? []) bump(reasonCounts, r);
      for (const s of entry.signals ?? []) bump(signalCounts, s);

      recent.push({
        timestamp: entry.timestamp,
        chosen_alias: entry.chosen_alias,
        intent: entry.intent,
        reason_codes: entry.reason_codes ?? [],
        signals: entry.signals ?? []
      });
    } catch {
      // ignore malformed lines
    }
  }

  recent.sort((a, b) => (toDateMs(a.timestamp) ?? 0) - (toDateMs(b.timestamp) ?? 0));
  const latest = recent.slice(-20);

  const out = {
    ok: true,
    logPath,
    window_hours: hours,
    total_events_in_window: recent.length,
    by_alias: Object.fromEntries(aliasCounts.entries()),
    by_intent: Object.fromEntries(intentCounts.entries()),
    by_reason_code: Object.fromEntries(reasonCounts.entries()),
    by_signal: Object.fromEntries(signalCounts.entries()),
    latest_events: latest
  };
  console.log(JSON.stringify(out, null, 2));
}

main();
