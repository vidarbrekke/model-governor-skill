# router-governor / model-governor skill

One repo for **model governance** on OpenClaw: canonical model aliases (OpenRouter) and router/default/fallback wiring. Use this for **version control and development**; installation into the live OpenClaw environment is separate (see below).

## What’s in this repo

- **config/models.json** — Alias → OpenRouter model ID (e.g. `router`, `default`, `codex`).
- **config/openclaw.json** — Snippet for OpenClaw: primary/fallbacks and `agents.defaults.models` shape. Merge into your live config.

## Usage (after installation)

- **Router:** `router` alias (lightweight triage).
- **Worker / default:** `default` or `qwen` for coding.
- **Fallbacks:** `gemini`, `sonnet`.
- **Advanced coding:** `codex` (gpt-5.3-codex). Do not use gpt-5.2-codex.

Ensure OpenClaw has the OpenRouter provider and API key configured; then use these aliases in agent config or `/model <alias>`.

## Installation (into live OpenClaw)

**This repo does not set any active parameters by itself.** Repo directories are for **development and version control**, not for live use. To use with OpenClaw:

1. Copy or merge **config/models.json** into your live config (e.g. `~/.openclaw/openclaw.json` under `agents.defaults.models` or `llm.modelAliases`).
2. Optionally merge the relevant keys from **config/openclaw.json** (primary/fallbacks) into the same file.
3. Live config lives in `~/.openclaw/` (or your workspace config). Do not rely on this repo path at runtime.

## Version control

This single folder is the git repo. Push to GitHub for backup and collaboration. On the server or another machine, clone this repo for development; then follow the installation steps above to copy/merge into that environment’s live OpenClaw config.

## License

MIT — see [LICENSE](LICENSE).
