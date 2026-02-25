# model-governor-skill

Model governance config for OpenClaw: canonical model aliases with OpenRouter provider prefixes. Use with the router-governor skill so the router and worker models resolve correctly.

## config/models.json

Maps friendly aliases to full OpenRouter model IDs (e.g. `openrouter/mistralai/ministral-14b-2512`). Copy or merge into your OpenClaw `openclaw.json` under `agents.defaults.models` (or use as reference for `llm.modelAliases`).

## config/openclaw.json

Optional snippet showing how to wire these models into OpenClaw (allowlist + primary/fallbacks). Merge relevant keys into your main `~/.openclaw/openclaw.json` or workspace config.

## Usage

- **Router:** Prefer `router` alias (lightweight triage).
- **Worker / default:** Prefer `default` or `qwen` for coding tasks.
- **Fallbacks:** Use `gemini` or `sonnet` as needed.

Ensure your OpenClaw instance has the corresponding provider (e.g. OpenRouter) and API key configured; then reference these aliases in agent config or `/model <alias>`.
