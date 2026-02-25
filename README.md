# router-governor / model-governor skill

One repo for **model governance** on OpenClaw: canonical model aliases (OpenRouter), router/default/fallback wiring, and the **router-governor skill** (routing policy and escalation rules). Use this for **version control and development**; installation into the live OpenClaw environment is separate (see below).

## What’s in this repo (dev directory)

| Path | Purpose |
|------|--------|
| **config/models.json** | Alias → OpenRouter model ID (`router`, `default`, `codex`, etc.). |
| **config/openclaw.json** | Snippet: primary/fallbacks and `agents.defaults.models` shape. Merge into live config. **Only** `router`, `default`, and `gemini` are wired here; `codex` and `sonnet` are available for manual override or future escalation tiers. |
| **config/policy.json** | Machine-checkable routing policy (budgets, signals, intent routing, reason codes). Logging section is a schema for runtime; implement in OpenClaw when hooks exist. |
| **skills/router-governor/SKILL.md** | Router-governor skill definition (routing policy, escalation rules). Install to `~/.openclaw/skills/router-governor/` or `workspace/skills/router-governor/`. |
| **skills/router-governor/examples.md** | Example prompts and escalation cases. |
| **tests/cases.jsonl** | Routing test cases (expected alias/intent per prompt); for future test harness. |

These are the files that **make up the model-governor / router-governor feature**. Other paths on a live server (e.g. `openclaw.json` root, `workspace/docs/CLOUD_AGENT_CONTEXT.md`, `workspace/memory/`, `workspace/scripts/`) are **workspace or machine-specific** and are **not** part of this repo. Install by copying/merging from this repo into the live environment.

## Usage (after installation)

- **Router:** `router` alias (lightweight triage).
- **Worker / default:** `default` or `qwen` for coding.
- **Fallbacks:** `gemini`, `sonnet`.
- **Advanced coding:** `codex` (gpt-5.3-codex). Do not use gpt-5.2-codex.

The snippet in **config/openclaw.json** only wires `router`, `default`, and `gemini`. Aliases `codex` and `sonnet` are defined in **config/models.json** and are available for manual override or future escalation tiers; add them to your live config if you use those tiers.

Ensure OpenClaw has the OpenRouter provider and API key configured; then use these aliases in agent config or `/model <alias>`.

## Installation (into live OpenClaw)

**This repo does not set any active parameters by itself.** Repo directories are for **development and version control**, not for live use. To use with OpenClaw:

1. **Model aliases:** Copy or merge **config/models.json** into your live config (e.g. `~/.openclaw/openclaw.json` under `agents.defaults.models` or `llm.modelAliases`).
2. **Primary/fallbacks:** Optionally merge the relevant keys from **config/openclaw.json** into the same file.
3. **Router-governor skill:** Copy **skills/router-governor/** to your OpenClaw skills directory, e.g.  
   `cp -r skills/router-governor ~/.openclaw/skills/`  
   or, on a workspace layout:  
   `cp -r skills/router-governor <workspace>/skills/`
4. Live config and skills live in `~/.openclaw/` (or your workspace). Do not rely on this repo path at runtime.

## What is not in this repo

- **Root openclaw.json** — Full live config; machine-specific. We only provide a **snippet** in `config/openclaw.json`.
- **CLOUD_AGENT_CONTEXT.md** — Workspace/agent context for the cloud instance; not part of the router-governor skill.
- **workspace/memory/** — Session and memory state; not versioned here.
- **workspace/scripts/** — Ops/setup scripts (e.g. fix-router-model-config) may reference this feature but live in the workspace; optional to copy into this repo later if you want them versioned.

## Version control

This single folder is the git repo. Push to GitHub for backup and collaboration. On the server or another machine, clone this repo for development; then follow the installation steps above to copy/merge into that environment’s live OpenClaw config.

## License

MIT — see [LICENSE](LICENSE).
