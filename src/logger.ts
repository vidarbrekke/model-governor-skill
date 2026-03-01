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
