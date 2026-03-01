import fs from "node:fs";
import path from "node:path";

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function appendJsonl(filePath: string, obj: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, "utf8");
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function enforceLogRetention(
  filePath: string,
  options: { retentionDays: number; maxFileBytes: number }
): void {
  if (!fs.existsSync(filePath)) return;

  const nowMs = Date.now();
  const cutoffMs = nowMs - options.retentionDays * 24 * 60 * 60 * 1000;
  const raw = fs.readFileSync(filePath, "utf8");
  const allLines = raw.split("\n").filter(line => line.trim().length > 0);

  const keptByTime = allLines.filter(line => {
    try {
      const parsed = JSON.parse(line) as { timestamp?: string };
      const ts = parseTimestamp(parsed.timestamp);
      return ts === null || ts >= cutoffMs;
    } catch {
      return true;
    }
  });

  // Keep newest lines when size exceeds cap.
  const keptBySize: string[] = [];
  let bytes = 0;
  for (let i = keptByTime.length - 1; i >= 0; i -= 1) {
    const line = keptByTime[i];
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (bytes + lineBytes > options.maxFileBytes) break;
    keptBySize.unshift(line);
    bytes += lineBytes;
  }

  const next = keptBySize.length > 0 ? `${keptBySize.join("\n")}\n` : "";
  fs.writeFileSync(filePath, next, "utf8");
}
