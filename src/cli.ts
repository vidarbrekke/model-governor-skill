#!/usr/bin/env node
/**
 * Governor bridge CLI: read prompt (and optional context) from stdin or argv,
 * call handle(), write log (if enabled), print SkillOutput as JSON to stdout.
 * Use for verification and for any runtime that can invoke this script when model=router.
 *
 * Usage:
 *   echo '{"text":"Debug this: ECONNREFUSED"}' | node dist/src/cli.js
 *   node dist/src/cli.js "Debug this: ECONNREFUSED"
 *
 * Env: ROUTER_GOVERNOR_POLICY_PATH, ROUTER_GOVERNOR_LOG_PATH (optional)
 */

import { handle } from "./index.js";

async function main() {
  let inputText: string;
  let sessionId: string | undefined;
  let requestId: string | undefined;

  const arg = process.argv[2];
  if (arg) {
    inputText = arg;
  } else {
    const chunks: string[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = chunks.join("").trim();
    if (!raw) {
      process.stderr.write("Usage: governor-bridge <prompt> or echo JSON | governor-bridge\n");
      process.exit(1);
    }
    try {
      const parsed = JSON.parse(raw) as { text: string; sessionId?: string; requestId?: string };
      inputText = parsed.text;
      sessionId = parsed.sessionId;
      requestId = parsed.requestId;
    } catch {
      inputText = raw;
    }
  }

  try {
    const out = await handle(
      { text: inputText },
      { sessionId, requestId }
    );
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch (err) {
    process.stderr.write(String(err) + "\n");
    process.exit(2);
  }
}

main();
