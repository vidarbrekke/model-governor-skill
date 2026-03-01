# Model Governor Skill (OpenClaw) — Implementation Guide (TypeScript)

This guide is designed to be **handed to an AI developer in Cursor** and implemented end-to-end with minimal ambiguity.

Goals:

- **Reduce LLM cost** by routing each request to the *cheapest* model that can reliably complete it.
- Keep routing **deterministic, bounded, and observable**.
- Ensure router does **triage only**; it should not “accidentally” do the whole job.
- Avoid “LLM-to-choose-LLM” loops (no Perplexity MCP or any network call for routing).

Non-goals (v1):

- No embeddings
- No semantic classifiers
- No dynamic pricing optimization
- No long-term multi-session learning

---

## Core Principles

### 1) Router is a classifier + policy enforcer (not a worker)
The router’s job:
- Identify intent
- Detect high-cost / high-risk signals
- Select a **worker alias**
- Produce a **minimal handoff summary**

The worker’s job:
- Do the actual work (code, debugging, refactor, web research, etc.)

### 2) Deterministic routing is cheaper than “smart routing”
Routing should be:
- **No network**
- **No model calls**
- **O(n)** over prompt length with small regex checks
- **Bounded output**

### 3) Observability is non-negotiable
If you don’t log routing decisions:
- you can’t tune signals
- you can’t measure misroutes
- you can’t prove cost savings

---

## Repository Layout (Recommended)

```
model-governor-skill/
  src/
    index.ts              # OpenClaw skill entrypoint
    router.ts             # routing logic
    signals.ts            # heuristic signal detectors
    policy.ts             # policy loader + validation
    logger.ts             # JSONL logging
    types.ts              # types + enums
    util.ts               # small helpers (hash, trim, etc.)
  config/
    policy.json
  tests/
    cases.jsonl
    router.test.ts
    run-cases.ts          # optional: CLI runner for quick checks
  package.json
  tsconfig.json
  README.md
```

---

## Policy: Machine-checkable Source of Truth

### `config/policy.json`

Use this as the single policy source; the prompt (SKILL.md) can describe it, but code enforces it.

```json
{
  "version": "0.1.0",

  "router_alias": "router",
  "default_worker_alias": "default",
  "fallback_worker_alias": "gemini",
  "escalation_tiers": ["default", "codex", "sonnet", "gemini"],

  "budgets": {
    "router": {
      "max_tool_calls": 2,
      "max_output_chars": 900,
      "max_turns_before_forced_escalation": 1
    }
  },

  "signals": {
    "hard_escalate_if_any": [
      "contains_patch_request",
      "contains_multi_file_request",
      "contains_stack_trace_or_error_log",
      "contains_code_block",
      "contains_cli_commands_request",
      "mentions_performance_optimization",
      "mentions_refactor_architecture",
      "mentions_test_suite_or_ci",
      "mentions_database_or_sql",
      "mentions_kubernetes_or_docker",
      "mentions_oauth_or_auth_flows",
      "long_input",
      "security_sensitive"
    ],
    "soft_escalate_if_any": [
      "requires_web_freshness",
      "ambiguous_requirements",
      "more_than_one_goal"
    ],
    "long_input_thresholds": {
      "chars": 7000,
      "lines": 220
    }
  },

  "intent_routing": {
    "simple_qa": { "worker": "router" },
    "triage_only": { "worker": "router" },

    "coding": { "worker": "default" },
    "debugging": { "worker": "default" },
    "config_edit": { "worker": "default" },

    "deep_refactor": { "worker": "codex" },
    "large_codebase_review": { "worker": "codex" },

    "writing_high_stakes": { "worker": "sonnet" },
    "web_research": { "worker": "gemini" }
  },

  "repeat_failure_rules": {
    "repeat_error_signature_escalate_after": 2,
    "signature_keys": ["error_code", "error_message_prefix", "tool_name"]
  },

  "logging": {
    "enabled": true,
    "format": "jsonl",
    "path": ".openclaw/logs/model-governor.jsonl",
    "fields": [
      "timestamp",
      "request_id",
      "session_id",
      "chosen_alias",
      "intent",
      "reason_codes",
      "signals",
      "router_tool_calls",
      "tokens_in",
      "tokens_out",
      "estimated_cost"
    ]
  }
}
```

---

## Types (Shared Contracts)

### `src/types.ts`

```ts
export type Intent =
  | "simple_qa"
  | "triage_only"
  | "coding"
  | "debugging"
  | "config_edit"
  | "deep_refactor"
  | "large_codebase_review"
  | "writing_high_stakes"
  | "web_research";

export interface Policy {
  version: string;

  router_alias: string;
  default_worker_alias: string;
  fallback_worker_alias: string;
  escalation_tiers: string[];

  budgets: {
    router: {
      max_tool_calls: number;
      max_output_chars: number;
      max_turns_before_forced_escalation: number;
    };
  };

  signals: {
    hard_escalate_if_any: string[];
    soft_escalate_if_any: string[];
    long_input_thresholds: { chars: number; lines: number };
  };

  intent_routing: Record<string, { worker: string }>;

  repeat_failure_rules: {
    repeat_error_signature_escalate_after: number;
    signature_keys: string[];
  };

  logging: {
    enabled: boolean;
    format: "jsonl";
    path: string;
    fields: string[];
  };
}

export interface RoutingDecision {
  intent: Intent;
  chosenAlias: string;
  reasonCodes: string[];
  signals: string[];
  constraints: string[];
  handoffSummary: string;
  confidence: number; // 0..1
}
```

---

## Policy Loader + Validation

### `src/policy.ts`

No heavy dependencies required. If you already use `zod` in your ecosystem, you can validate with it; otherwise do minimal checks.

```ts
import fs from "node:fs";
import path from "node:path";
import { Policy } from "./types";

export function loadPolicy(policyPath: string): Policy {
  const abs = path.isAbsolute(policyPath) ? policyPath : path.join(process.cwd(), policyPath);
  const raw = fs.readFileSync(abs, "utf8");
  const obj = JSON.parse(raw) as Policy;

  // Minimal validation (v1)
  if (!obj.router_alias || !obj.default_worker_alias) {
    throw new Error("Invalid policy.json: missing router_alias or default_worker_alias");
  }
  if (!obj.budgets?.router?.max_tool_calls) {
    throw new Error("Invalid policy.json: missing budgets.router.max_tool_calls");
  }

  return obj;
}
```

---

## Signals (Heuristic Detectors)

### `src/signals.ts`

This is the “cheap brain”. Keep it fast and conservative.

```ts
export function detectSignals(prompt: string) {
  const s: string[] = [];

  const lines = prompt.split(/\r?\n/);
  const lineCount = lines.length;

  if (prompt.includes("```")) s.push("contains_code_block");
  if (/patch|diff|unified diff|git diff/i.test(prompt)) s.push("contains_patch_request");
  if (/stack trace|traceback|exception|error:/i.test(prompt)) s.push("contains_stack_trace_or_error_log");
  if (/(^|\s)(Dockerfile|docker-compose|kubernetes|helm|k8s)\b/i.test(prompt)) s.push("mentions_kubernetes_or_docker");
  if (/\bSQL\b|SELECT\b|INSERT\b|UPDATE\b|migrate|migration/i.test(prompt)) s.push("mentions_database_or_sql");
  if (/\bOAuth\b|OIDC|SAML|JWT|refresh token|client secret/i.test(prompt)) s.push("mentions_oauth_or_auth_flows");
  if (/optimi[sz]e|performance|latency|throughput|benchmark/i.test(prompt)) s.push("mentions_performance_optimization");
  if (/refactor|architecture|module boundary|restructure/i.test(prompt)) s.push("mentions_refactor_architecture");
  if (/CI\b|GitHub Actions|pipeline|unit tests|integration tests|vitest|jest/i.test(prompt)) s.push("mentions_test_suite_or_ci");
  if (/command|bash|zsh|powershell|one-liner|shell script/i.test(prompt)) s.push("contains_cli_commands_request");

  // Security-sensitive triggers (keep conservative; expand later)
  if (/password|api key|secret|credential|token\b/i.test(prompt)) s.push("security_sensitive");

  // Long input
  if (prompt.length > 7000 || lineCount > 220) s.push("long_input");

  // Freshness / web requirement signal (user asks for “latest”, “today”, etc.)
  if (/\blatest\b|\btoday\b|\bthis week\b|\bcurrent\b|\brecent\b/i.test(prompt)) s.push("requires_web_freshness");

  // Multi-goal
  if (/instead of|also|and then|secondly|third/i.test(prompt)) s.push("more_than_one_goal");

  return s;
}
```

---

## Intent Classification (Cheap + Conservative)

### `src/router.ts`

You can keep intent classification simple at first:
- If hard signals: classify into the relevant worker intent
- Else default to `simple_qa` or `triage_only`

```ts
import { detectSignals } from "./signals";
import { Policy, RoutingDecision, Intent } from "./types";

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

function chooseIntent(signals: string[], prompt: string): { intent: Intent; confidence: number; reasons: string[] } {
  const reasons: string[] = [];

  // If web freshness requested → web research
  if (signals.includes("requires_web_freshness")) {
    reasons.push("soft_web_freshness");
    return { intent: "web_research", confidence: 0.75, reasons };
  }

  // Debugging / error logs
  if (signals.includes("contains_stack_trace_or_error_log")) {
    reasons.push("signal_stack_trace");
    return { intent: "debugging", confidence: 0.85, reasons };
  }

  // Code block or patch → coding
  if (signals.includes("contains_code_block") || signals.includes("contains_patch_request")) {
    reasons.push("signal_code_or_patch");
    return { intent: "coding", confidence: 0.8, reasons };
  }

  // Refactor/arch/perf → deep refactor
  if (signals.includes("mentions_refactor_architecture") || signals.includes("mentions_performance_optimization")) {
    reasons.push("signal_refactor_or_perf");
    return { intent: "deep_refactor", confidence: 0.7, reasons };
  }

  // Config edit
  if (/openclaw\.json|models\.json|config|json/i.test(prompt)) {
    reasons.push("pattern_config");
    return { intent: "config_edit", confidence: 0.65, reasons };
  }

  // Otherwise: simple QA / triage
  return { intent: "simple_qa", confidence: 0.6, reasons };
}

export function route(prompt: string, policy: Policy): RoutingDecision {
  const signals = detectSignals(prompt);

  const reasonCodes: string[] = [];
  const constraints: string[] = [];

  const hardEscalate = signals.some(x => policy.signals.hard_escalate_if_any.includes(x));
  const softEscalate = signals.some(x => policy.signals.soft_escalate_if_any.includes(x));

  const { intent, confidence, reasons } = chooseIntent(signals, prompt);
  reasonCodes.push(...reasons);

  // Escalation logic:
  // - hard escalate always routes to worker (unless intent is already router)
  // - soft escalate nudges away from router if confidence is low
  let chosenAlias: string;

  const intentWorker = policy.intent_routing[intent]?.worker ?? policy.default_worker_alias;

  if (intent === "simple_qa" && !hardEscalate && !softEscalate) {
    chosenAlias = policy.router_alias;
    reasonCodes.push("simple_qa");
  } else {
    chosenAlias = intentWorker;
    if (hardEscalate) reasonCodes.push("hard_escalate_signal");
    if (softEscalate) reasonCodes.push("soft_escalate_signal");
  }

  // Router guardrail: if chosenAlias is router but signals suggest complexity → bump to default
  if (chosenAlias === policy.router_alias && (hardEscalate || confidence < 0.55)) {
    chosenAlias = policy.default_worker_alias;
    reasonCodes.push("router_disallowed_action");
  }

  // Minimal handoff summary
  const summary = summarizeForHandoff(prompt);

  return {
    intent,
    chosenAlias,
    reasonCodes,
    signals,
    constraints,
    handoffSummary: summary,
    confidence: clamp01(confidence)
  };
}

function summarizeForHandoff(prompt: string): string {
  // Keep this extremely short, deterministic, and safe.
  // Do NOT include secrets. Strip obvious secret patterns.
  const scrubbed = prompt
    .replace(/(api[_ -]?key|secret|password)\s*[:=]\s*\S+/gi, "$1:[REDACTED]")
    .trim();

  const first = scrubbed.split(/\r?\n/).find(l => l.trim().length > 0) ?? "";
  return first.slice(0, 240);
}
```

---

## Logging (JSONL)

### `src/logger.ts`

```ts
import fs from "node:fs";
import path from "node:path";

export function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

export function appendJsonl(filePath: string, obj: Record<string, unknown>) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
}
```

---

## Skill Entrypoint (OpenClaw Integration Pattern)

This section is intentionally generic because OpenClaw skill runtime APIs can vary by version.
Your developer should adapt `handle()` to OpenClaw’s actual skill invocation contract.

### `src/index.ts`

```ts
import { loadPolicy } from "./policy";
import { route } from "./router";
import { appendJsonl } from "./logger";

type SkillContext = {
  sessionId?: string;
  requestId?: string;
  // plus whatever OpenClaw provides: tool usage, token counts, etc.
};

type SkillInput = {
  text: string;
  // optionally: prior messages, tool results, etc.
};

type SkillOutput =
  | { mode: "respond"; text: string }
  | { mode: "handoff"; chosenAlias: string; handoff: Record<string, unknown> };

const policy = loadPolicy("config/policy.json");

export async function handle(input: SkillInput, ctx: SkillContext): Promise<SkillOutput> {
  const decision = route(input.text, policy);

  // Log decision
  if (policy.logging.enabled) {
    appendJsonl(policy.logging.path, {
      timestamp: new Date().toISOString(),
      request_id: ctx.requestId ?? null,
      session_id: ctx.sessionId ?? null,
      chosen_alias: decision.chosenAlias,
      intent: decision.intent,
      reason_codes: decision.reasonCodes,
      signals: decision.signals,
      router_tool_calls: 0,
      tokens_in: null,
      tokens_out: null,
      estimated_cost: null
    });
  }

  // If router handles it, keep response short and non-ambitious.
  if (decision.chosenAlias === policy.router_alias) {
    const text = routerRespond(input.text);
    return { mode: "respond", text };
  }

  // Otherwise hand off with minimal context.
  return {
    mode: "handoff",
    chosenAlias: decision.chosenAlias,
    handoff: {
      intent: decision.intent,
      reason_codes: decision.reasonCodes,
      signals: decision.signals,
      constraints: decision.constraints,
      handoff_summary: decision.handoffSummary,
      original_user_text: input.text
    }
  };
}

function routerRespond(prompt: string): string {
  // Router should triage and ask 0–2 clarifying questions max.
  // Prefer "actionable next step" style without deep work.
  if (prompt.length < 160) {
    return "Got it. What outcome do you want (1–2 sentences), and what constraints matter most (time/cost/quality)?";
  }
  return "I can route this to the best model. Before I do: what output format do you want (diff, plan, checklist), and is web-fresh info required?";
}
```

> Implementation note: If OpenClaw already supports a canonical return shape for “handoff” / “delegate to model alias”, your developer should map `SkillOutput` into that.

---

## The Router Output Contract (Make Handoffs Predictable)

The worker should always receive a minimal structured envelope:

```json
{
  "intent": "debugging",
  "reason_codes": ["hard_escalate_signal", "signal_stack_trace"],
  "signals": ["contains_stack_trace_or_error_log"],
  "constraints": ["patch-style diff", "minimal changes"],
  "handoff_summary": "Error: ECONNREFUSED 127.0.0.1:5432",
  "original_user_text": "...full prompt..."
}
```

This improves worker performance and reduces back-and-forth.

---

## Tests: Routing Eval Set

### `tests/cases.jsonl`

Each case has:
- prompt
- expected alias
- expected intent
- max router tool calls (budget)

```jsonl
{"id":"T001","prompt":"What is OpenClaw? 2 sentences.","expected_alias":"router","expected_intent":"simple_qa","max_router_tool_calls":0}
{"id":"T010","prompt":"Here is a stack trace. Find root cause:\nError: ECONNREFUSED 127.0.0.1:5432\n...","expected_alias":"default","expected_intent":"debugging","max_router_tool_calls":1}
{"id":"T012","prompt":"I need a patch-style diff to refactor this function:\n```go\nfunc X(){/* long */}\n```","expected_alias":"default","expected_intent":"coding","max_router_tool_calls":1}
{"id":"T020","prompt":"Review this repo (8 files) and propose new module boundaries + refactor plan.","expected_alias":"codex","expected_intent":"deep_refactor","max_router_tool_calls":1}
{"id":"T050","prompt":"What changed in the last 60 days about OpenClaw MCP support? Cite sources.","expected_alias":"gemini","expected_intent":"web_research","max_router_tool_calls":1}
```

Add 30–50 more as you iterate.

---

## Test Runner (Fast Feedback)

### `tests/router.test.ts` (Vitest)

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { loadPolicy } from "../src/policy";
import { route } from "../src/router";

type Case = {
  id: string;
  prompt: string;
  expected_alias: string;
  expected_intent: string;
};

describe("routing cases", () => {
  const policy = loadPolicy("config/policy.json");
  const lines = fs.readFileSync("tests/cases.jsonl", "utf8").trim().split("\n");
  const cases = lines.map(l => JSON.parse(l) as Case);

  for (const c of cases) {
    it(c.id, () => {
      const d = route(c.prompt, policy);
      expect(d.chosenAlias).toBe(c.expected_alias);
      expect(d.intent).toBe(c.expected_intent);
    });
  }
});
```

### Optional: `tests/run-cases.ts` CLI

```ts
import fs from "node:fs";
import { loadPolicy } from "../src/policy";
import { route } from "../src/router";

const policy = loadPolicy("config/policy.json");
const lines = fs.readFileSync("tests/cases.jsonl", "utf8").trim().split("\n");

let fails = 0;

for (const line of lines) {
  const c = JSON.parse(line) as any;
  const d = route(c.prompt, policy);

  const ok = d.chosenAlias === c.expected_alias && d.intent === c.expected_intent;
  if (!ok) {
    fails++;
    console.error(`FAIL ${c.id} expected alias=${c.expected_alias} intent=${c.expected_intent}`);
    console.error(`     got      alias=${d.chosenAlias} intent=${d.intent} reasons=${d.reasonCodes.join(",")}`);
  }
}

process.exit(fails ? 1 : 0);
```

---

## Perplexity MCP: Where It Fits (and Where It Doesn’t)

### Do **not** use Perplexity MCP for routing
Routing must not call network tools or LLMs.

### It **can** be used by the worker for `web_research` intent
Flow:
1. Router sees freshness requirement → intent = `web_research` → worker alias `gemini`
2. Worker uses Perplexity MCP (or native web tool) to fetch citations
3. Worker answers

This keeps routing cheap and correctness high.

---

## Next Steps Checklist (Implementation Order)

1) **Wire policy.json** into the skill and enforce budgets.
2) Implement `route()` + `detectSignals()` exactly as cheap pure functions.
3) Add **JSONL logging** to a stable path.
4) Create `tests/cases.jsonl` with 30–50 cases and run in CI.
5) Iterate:
   - add signals slowly
   - adjust intent mapping in policy.json
   - measure misroutes via logs

---

## Practical Tuning Tips

- If you see the router routing too much to workers:
  - relax `hard_escalate_if_any`
  - tighten detection of code-block / patch
- If you see the router trying to handle complex tasks:
  - bump guardrails: router disallowed if any hard signals exist
  - lower confidence threshold for escalation
- If you see workers getting under-specified prompts:
  - improve `handoffSummary` and `constraints` extraction (still deterministic)

---

## Appendix: Minimal `package.json` (Example)

```json
{
  "name": "model-governor-skill",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "cases": "node --loader ts-node/esm tests/run-cases.ts"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.0.0",
    "ts-node": "^10.9.2"
  }
}
```

---

## What Your Developer Should Do in Cursor

- Implement the folder structure
- Plug `handle()` into OpenClaw’s skill runtime contract
- Ensure a “handoff” return triggers the correct **model alias** in OpenClaw
- Add 30–50 routing cases from your real usage
- Run `vitest` and iterate policy + signals based on logs

---

If you want to tighten this further, the next enhancement is a **repeat-error signature** mechanism:
- store last N tool errors in session metadata
- if the same error signature happens twice → escalate to next tier

That’s a huge win for “stuck tool loops” and saves cost immediately.
