# router-governor / model-governor skill

## What this is

**Router-governor** is a **model governance** layer for [OpenClaw](https://github.com/OpenClaw/OpenClaw). It decides which AI model should handle each user request—a lightweight “router” for simple questions, or a more capable “worker” (e.g. coding, debugging, web research)—so you use the cheapest model that can reliably do the job.

**When it applies:** This logic runs only when the **router** model is selected (e.g. `/model router` or your agent is set to use the `router` alias). If the user has already chosen a different model (e.g. `default` or `codex`), that model handles the request directly and the governor is not involved.

## What it does

- **Triages incoming requests** using simple, fast rules (no extra model calls): e.g. “contains code”, “stack trace”, “needs latest info”, “multi-step refactor”.
- **Picks a target model** from your configured aliases (`router`, `default`, `codex`, `sonnet`, `gemini`) and either lets the router answer in-place (short, bounded) or hands off to that model with a small context envelope.
- **Enforces budgets and safety**: limits how many tool calls and turns the router may use, escalates when the same error repeats, and keeps the router from doing heavy work itself.
- **Logs every decision** (e.g. JSONL) so you can see why something was routed where and tune the policy from real usage. When the **code runtime** (`src/`) is wired and `policy.logging.enabled` is true, it writes a **dedicated log file** (see [Logging model changes and reasons](#logging-model-changes-and-reasons) below).

## Why it works

- **Deterministic and cheap:** Routing uses regex-style checks and policy only—no network or extra LLM call—so it’s fast, predictable, and easy to test.
- **One source of truth:** All behavior is driven by `config/policy.json` (signals, budgets, intent→model mapping). You change policy, not code, to tune behavior.
- **Clear split of roles:** The router only classifies and hands off; workers do the actual coding, research, or writing. That avoids “router does the whole job” and keeps cost and behavior under control.

This repo holds the **config, skill text, and code** for that layer. You use it for version control and development; installing into a live OpenClaw setup is a separate step (see [Installation](#installation-into-live-openclaw) below).

---

## What’s in this repo (dev directory)

| Path | Purpose |
|------|--------|
| **config/models.json** | Alias → OpenRouter model ID (`router`, `default`, `codex`, etc.). |
| **config/openclaw.json** | Snippet: primary/fallbacks, `agents.defaults.models` (allowlist), and `models.providers.openrouter` (provider catalog). Merge into live config. |
| **config/policy.json** | Machine-checkable routing policy (budgets, signals, intent routing, reason codes). Logging section is a schema for runtime; implement in OpenClaw when hooks exist. |
| **skills/router-governor/SKILL.md** | Router-governor skill definition (routing policy, escalation rules). Install to `~/.openclaw/skills/router-governor/` or `workspace/skills/router-governor/`. |
| **skills/router-governor/examples.md** | Example prompts and escalation cases. |
| **src/** | Code-enforced routing runtime: types, policy loader, signal detection, router, logger, and OpenClaw skill entrypoint. See [Code runtime (src/)](#code-runtime-src) below. |
| **tests/cases.jsonl** | Routing test cases (expected alias/intent per prompt). Run via `npm test` or `npm run cases`. |

These are the files that **make up the model-governor / router-governor feature**. Other paths on a live server (e.g. `openclaw.json` root, `workspace/docs/CLOUD_AGENT_CONTEXT.md`, `workspace/memory/`, `workspace/scripts/`) are **workspace or machine-specific** and are **not** part of this repo. Install by copying/merging from this repo into the live environment.

## Usage (after installation)

- **Router:** `router` alias (lightweight triage).
- **Worker / default:** `default` or `qwen` for coding.
- **Fallbacks:** `gemini`, `sonnet`.
- **Advanced coding:** Use **`/model openrouter/openai/gpt-5.3-codex`** (full ref). Alias **`codex53`** is configured but on some OpenClaw versions a bare token like `codex53` is resolved as **anthropic/codex53** (default provider), so it fails "not allowed." The full ref avoids that. See [docs/5-WHYS-MODEL-CODEX.md](docs/5-WHYS-MODEL-CODEX.md) for root-cause analysis.
- **If the reply says "Model set to … gpt-5.1-codex":** The app’s built-in catalog can overwrite the stored/displayed model id with 5.1; see the 5-whys doc. Prefer the full ref above; if the reply still shows 5.1, it may be an OpenClaw bug to report.

The snippet in **config/openclaw.json** only wires `router`, `default`, and `gemini`. Aliases `codex` and `sonnet` are defined in **config/models.json** and are available for manual override or future escalation tiers; add them to your live config if you use those tiers.

Ensure OpenClaw has the OpenRouter provider and API key configured; then use these aliases in agent config or `/model <alias>`.

## Code runtime (src/)

The `src/` tree implements **deterministic, policy-driven routing** so behavior is not prompt-only. Integrate it with OpenClaw’s skill runtime by calling the exported `handle()` function.

### Contracts

- **Policy:** Single source of truth is `config/policy.json`. Loaded at startup via `loadPolicy(path)`; invalid or missing required fields throw.
- **SkillInput:** `{ text: string; routerToolCalls?: number; turnIndex?: number; previousErrorSignatures?: string[]; latestErrorSignature?: string }`. The runtime should pass user prompt as `text` and, when available, router turn/tool counts and error signatures for budget and repeat-failure escalation.
- **SkillContext:** `{ sessionId?: string; requestId?: string; tokensIn?: number; tokensOut?: number; estimatedCost?: number }`. Used for JSONL logging only.
- **SkillOutput:** Either `{ mode: "respond"; text: string }` (router answers in-place, bounded by `policy.budgets.router.max_output_chars`) or `{ mode: "handoff"; chosenAlias: string; handoff: Record<string, unknown>; announcement?: string }`. The `handoff` object contains `intent`, `reason_codes`, `signals`, `constraints`, `handoff_summary`, and `original_user_text` for the worker. Map `chosenAlias` to your OpenClaw model alias (e.g. `default`, `codex`, `sonnet`, `gemini`).

### Shadow mode

When **shadow mode** is on, the governor logs the routing decision (including the alias it would have chosen) but **always returns a handoff to the default worker**. Use this to collect logs and tune policy without changing live behavior. Enable via:

- **Env:** `ROUTER_GOVERNOR_SHADOW_MODE=1`
- **Policy (optional):** `"shadow_mode": true` in `config/policy.json`

Log lines include `shadow_chosen_alias` when shadow mode is active.

### Logging model changes and reasons

When the **code runtime** is used and `config/policy.json` has `logging.enabled: true`, the governor **writes every routing decision** to a **dedicated JSONL log file**. That file records the **model chosen** and the **reason for the change** (and related context) on each request.

**How to enable or disable:** Logging is controlled only by the **policy file** (no env var). In the `logging` section of `config/policy.json`:

- **Default (this repo’s sample policy):** `"enabled": true` — logging is **on** when you use the bundled policy as-is and the code runtime is wired.
- **Disable:** Set `"enabled": false`. No log file is written.
- **Enable (if you turned it off):** Set `"enabled": true`.
- **Log path (optional):** Set `"path": "/your/path/model-governor.jsonl"` to choose where the file is written. If omitted, the default is `.openclaw/logs/model-governor.jsonl` (relative to the process working directory). The process must have write access to that path.

If the **code runtime** is not integrated (e.g. OpenClaw only runs the skill text and never calls `handle()`), no log file is produced regardless of `enabled`.

**Recommended use:** Treat the log as **diagnostics and policy review only**, not as a long-term audit trail. **Purge or rotate it regularly** (e.g. keep the last 7–14 days or a few MB) so disk use and retained data stay bounded. Use cron, logrotate, or a similar mechanism; exact retention is up to your environment.

- **Per-line fields (typical):**
  - `timestamp` — ISO time of the decision
  - `request_id`, `session_id` — when provided by the runtime
  - **`chosen_alias`** — model that will handle the request (`router`, `default`, `codex`, `sonnet`, `gemini`)
  - **`intent`** — e.g. `simple_qa`, `coding`, `debugging`, `web_research`
  - **`reason_codes`** — why this alias was chosen (e.g. `hard_escalate_signal`, `coding`, `budget_exceeded`, `repeat_error_signature`)
  - **`signals`** — detected triggers (e.g. `contains_code_block`, `long_input`)
  - `router_tool_calls` — count when available
  - `tokens_in`, `tokens_out`, `estimated_cost` — placeholders when the runtime supplies them
  - `shadow_chosen_alias` — (only when shadow mode is on) the alias that would have been chosen if not shadowing

So **yes, the solution logs model changes and the reason for the change** in that file. The **in-chat handoff line** (e.g. `[→ **default** | intent: coding | reason: hard_escalate_signal]`) is the user-visible summary; the JSONL log is the machine-readable audit trail for debugging and tuning. If the runtime is not yet integrated or logging is disabled, only the handoff line (and session history) is available.

### Tests and scripts

- **`npm test`** — Runs Vitest against `tests/cases.jsonl` (alias + intent per case). Block merges on failures.
- **`npm run cases`** — Same cases via CLI; exits 1 on first failure and prints expected vs got.
- **`npm run build`** — Compiles TypeScript to `dist/`.

Add new cases to `tests/cases.jsonl` (one JSON object per line with `id`, `prompt`, `expected_alias`, `expected_intent`) and expand to 30–50 real prompts to tune misroutes.

## Installation (into live OpenClaw)

**This repo does not set any active parameters by itself.** Repo directories are for **development and version control**, not for live use. To use with OpenClaw:

1. **Model aliases:** Copy or merge **config/models.json** into your live config (e.g. `~/.openclaw/openclaw.json` under `agents.defaults.models` or `llm.modelAliases`).
2. **Primary/fallbacks:** Optionally merge the relevant keys from **config/openclaw.json** into the same file.
3. **Router-governor skill:** Copy **skills/router-governor/** to your OpenClaw skills directory, e.g.  
   `cp -r skills/router-governor ~/.openclaw/skills/`  
   or, on a workspace layout:  
   `cp -r skills/router-governor <workspace>/skills/`
4. **Allowlist + provider catalog:** OpenClaw only allows models that are (a) in `agents.defaults.models` (allowlist for `/model`) and (b) in the provider’s model catalog. The snippet includes `models.providers.openrouter` and `models.providers.fireworks` (kimi only). Merge the full **config/openclaw.json** snippet (including the `models` block) into your live config so you don’t get “Model … is not allowed.” All models are OpenRouter except **kimi** (`/fireworks/models/kimi-k2p5`), which is the only non-OpenRouter model; configure Fireworks auth (e.g. `FIREWORKS_API_KEY`) if you use kimi.
5. Live config and skills live in `~/.openclaw/` (or your workspace). Do not rely on this repo path at runtime.

## What is not in this repo

- **Root openclaw.json** — Full live config; machine-specific. We only provide a **snippet** in `config/openclaw.json`.
- **CLOUD_AGENT_CONTEXT.md** — Workspace/agent context for the cloud instance; not part of the router-governor skill.
- **workspace/memory/** — Session and memory state; not versioned here.
- **workspace/scripts/** — Ops/setup scripts (e.g. fix-router-model-config) may reference this feature but live in the workspace; optional to copy into this repo later if you want them versioned.

## Version control

This single folder is the git repo. Push to GitHub for backup and collaboration. On the server or another machine, clone this repo for development; then follow the installation steps above to copy/merge into that environment’s live OpenClaw config.

## License

MIT — see [LICENSE](LICENSE).
