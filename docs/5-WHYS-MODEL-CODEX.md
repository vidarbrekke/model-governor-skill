# 5-Whys: /model codex53 and openrouter/openai/gpt-5.3-codex

## Symptom 1: `/model codex53` → "Model anthropic/codex53 is not allowed"

### Why 1: Why is the model "anthropic/codex53"?
Because the gateway resolved the string `codex53` to provider **anthropic** and model **codex53**.

### Why 2: Why does "codex53" get provider anthropic?
Because when the model argument **has no slash**, OpenClaw uses a **default provider**. In the OpenClaw bundle (`model-selection-*.js`): `const DEFAULT_PROVIDER = "anthropic";`. So `parseModelRef("codex53", defaultProvider)` becomes `normalizeModelRef("anthropic", "codex53")` → `{ provider: "anthropic", model: "codex53" }` → **anthropic/codex53**.

### Why 3: Why isn’t the allowlist alias "codex53" used first?
`resolveModelRefFromString` is designed to resolve bare tokens via `params.aliasIndex?.byAlias`: if there’s no "/" it looks up the alias and, if found, returns the allowlist ref (e.g. openrouter/openai/gpt-5.3-codex). So alias resolution **should** run before default-provider fallback. That only works if the caller passes `aliasIndex` built from the current config allowlist. If the `/model` handler doesn’t pass `aliasIndex`, or uses a different code path that only calls `parseModelRef(raw, DEFAULT_PROVIDER)`, then the default provider is applied and we get anthropic/codex53.

### Why 4: Why would the handler not use the alias index?
Either the slash-command path doesn’t build/pass the allowlist alias index when resolving the model string, or the allowlist isn’t available in that context. This is an OpenClaw implementation detail; we don’t control it from this repo.

### Why 5 (root cause): Why does this happen?
**Root cause:** When the user sends a single token (no "/"), OpenClaw’s default-provider fallback is **anthropic**. If alias resolution from the allowlist is not applied first (or not in this code path), the ref becomes **anthropic/{token}**, which is not in our allowlist → "not allowed."

**Workaround:** Use the full model ref so parsing never uses the default provider: **`/model openrouter/openai/gpt-5.3-codex`**.

---

## Symptom 2: `/model openrouter/openai/gpt-5.3-codex` → "Model set to openrouter/openai/gpt-5.1-codex"

### Why 1: Why does the user see gpt-5.1-codex?
Because the gateway (or the component that formats the "Model set to X" message) is returning / displaying **gpt-5.1-codex** as the model id instead of gpt-5.3-codex.

### Why 2: Where does gpt-5.1 come from?
In the OpenClaw bundle: `OPENAI_DEFAULT_MODEL = "openai/gpt-5.1-codex"` (e.g. in `openai-model-default-*.js`). The built-in pi-ai catalog and model-selection code reference both gpt-5.2-codex and gpt-5.3-codex; gpt-5.1-codex is the default OpenAI Codex model id in the app. So somewhere in the pipeline (catalog merge, display logic, or session storage) the id is being replaced or overridden with the built-in default (5.1).

### Why 3: Why would 5.3 be replaced by 5.1?
Possible causes: (a) The merged model catalog (built-in + our `models.providers.openrouter`) has an openrouter entry for "codex" that points to **openai/gpt-5.1-codex** in the built-in list, and when we add openrouter/openai/gpt-5.3-codex to the allowlist, the UI or set-model logic looks up the ref in the catalog and uses the catalog’s model id (5.1) for display or storage. (b) Or there is explicit normalization logic that maps openrouter/openai/gpt-5.3-codex → openai/gpt-5.1-codex. We confirmed `normalizeProviderModelId` does not change 5.3→5.1 for openrouter; the substitution is likely in catalog merge or in the code that builds the "Model set to" message.

### Why 4: Why does the catalog or message use 5.1?
The pi-ai embedded catalog or default model constants favor **gpt-5.1-codex** as the canonical Codex model id. When the runtime merges our provider list with the built-in catalog, or when it resolves "which model id to show/store", it may pick the built-in id (5.1) instead of the allowlist key (5.3).

### Why 5 (root cause): Why does this happen?
**Root cause:** OpenClaw’s built-in catalog or default-model logic uses **gpt-5.1-codex** as the default Codex id. When the user selects **openrouter/openai/gpt-5.3-codex** (from the allowlist), something in the flow (catalog lookup, display, or session persistence) substitutes or displays the built-in default id (**5.1**) instead of the requested id (**5.3**). So the user sees "Model set to openrouter/openai/gpt-5.1-codex" even though they asked for 5.3.

**Workaround:** Until OpenClaw preserves the exact allowlist model id end-to-end, we cannot force the UI to show 5.3 if the app overwrites it with 5.1. Using **`/model openrouter/openai/gpt-5.3-codex`** may still result in the reply saying 5.1; the actual model used for the next request might still be 5.1 if the session stores the substituted id. **Report to OpenClaw:** allowlist model keys should be the single source of truth for both allow-check and for display/session storage (no substitution to built-in default ids).

---

## Summary

| Symptom | Root cause | Workaround |
|--------|------------|------------|
| `/model codex53` → anthropic/codex53 not allowed | Bare token "codex53" gets default provider **anthropic** when allowlist alias resolution isn’t applied first. | Use **`/model openrouter/openai/gpt-5.3-codex`** (full ref). |
| `/model openrouter/openai/gpt-5.3-codex` → "Model set to … gpt-5.1-codex" | Built-in catalog/default uses **gpt-5.1-codex**; something in the flow overwrites or displays 5.1 instead of 5.3. | Report to OpenClaw; no reliable workaround from config only. |
