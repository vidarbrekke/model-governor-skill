#!/usr/bin/env bash
# Verify that the live OpenClaw config still contains router-governor model allowlist/provider blocks.
# This protects against silent drift where /model router falls back to a provider default.
set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_HOME/openclaw.json}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_OPENCLAW_CONFIG="${OPENCLAW_GOVERNOR_CONFIG:-$REPO_ROOT/config/openclaw.json}"

if [ ! -f "$OPENCLAW_CONFIG_PATH" ]; then
  echo "FAIL: live openclaw config not found at $OPENCLAW_CONFIG_PATH"
  exit 1
fi

if [ ! -f "$REPO_OPENCLAW_CONFIG" ]; then
  echo "FAIL: expected router-governor config not found at $REPO_OPENCLAW_CONFIG"
  exit 1
fi

node - <<'NODE'
import fs from "node:fs";
import path from "node:path";

const liveConfigPath = process.env.OPENCLAW_CONFIG_PATH;
const expectedConfigPath = process.env.OPENCLAW_GOVERNOR_CONFIG;

const live = JSON.parse(fs.readFileSync(liveConfigPath, "utf8"));
const expected = JSON.parse(fs.readFileSync(expectedConfigPath, "utf8"));

const toObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

const liveDefaults = toObject(live?.agents?.defaults);
const liveModels = toObject(liveDefaults?.models);
const expectedModels = toObject(expected?.agents?.defaults?.models);

const liveProviders = toObject(live?.models?.providers);
const expectedProviders = toObject(expected?.models?.providers);

const errors = [];

if (!toObject(liveDefaults?.model)?.primary) {
  errors.push("missing agents.defaults.model.primary");
}

if (!Array.isArray(liveDefaults?.model?.fallbacks) || liveDefaults.model.fallbacks.length === 0) {
  errors.push("missing or empty agents.defaults.model.fallbacks");
}

if (!liveModels) {
  errors.push("missing agents.defaults.models");
} else if (!expectedModels) {
  errors.push("expected config missing agents.defaults.models in repository copy");
} else {
  const missingAliases = Object.keys(expectedModels).filter((alias) => !(alias in liveModels));
  if (missingAliases.length) {
    errors.push(`missing aliases in agents.defaults.models: ${missingAliases.join(", ")}`);
  }
}

if (!liveProviders) {
  errors.push("missing models.providers");
} else if (!expectedProviders) {
  errors.push("expected config missing models.providers in repository copy");
} else {
  for (const [provider, expectedProvider] of Object.entries(expectedProviders)) {
    const liveProvider = toObject(liveProviders?.[provider]);
    if (!liveProvider) {
      errors.push(`missing models.providers.${provider}`);
      continue;
    }
    if (!Array.isArray(liveProvider.models) || liveProvider.models.length === 0) {
      errors.push(`models.providers.${provider}.models is missing or empty`);
    }
    if (expectedProvider?.baseUrl && typeof expectedProvider.baseUrl === "string" && (!liveProvider.baseUrl || typeof liveProvider.baseUrl !== "string")) {
      errors.push(`models.providers.${provider}.baseUrl is missing`);
    }
  }
}

if (errors.length) {
  console.error(`FAIL: openclaw router config check failed for ${path.resolve(liveConfigPath)}`);
  for (const e of errors) {
    console.error(`- ${e}`);
  }
  process.exit(1);
}

console.log(`PASS: openclaw router config check passed for ${path.resolve(liveConfigPath)}`);
console.log(`- aliases in agents.defaults.models: ${Object.keys(liveModels).length}`);
console.log(`- providers in models.providers: ${Object.keys(liveProviders).join(", ")}`);
NODE
