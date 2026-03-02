import fs from "node:fs";
import path from "node:path";
import { Policy } from "./types.js";

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid policy.json: ${label} must be a non-empty string`);
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new Error(`Invalid policy.json: ${label} must be an array of strings`);
  }
}

function validatePolicy(obj: Partial<Policy>): asserts obj is Policy {
  assertString(obj.router_alias, "router_alias");
  assertString(obj.default_worker_alias, "default_worker_alias");
  assertString(obj.fallback_worker_alias, "fallback_worker_alias");
  assertStringArray(obj.escalation_tiers, "escalation_tiers");

  if (!obj.budgets?.router) {
    throw new Error("Invalid policy.json: missing budgets.router");
  }

  if (!isPositiveInteger(obj.budgets.router.max_tool_calls)) {
    throw new Error("Invalid policy.json: budgets.router.max_tool_calls must be a positive integer");
  }
  if (!isPositiveInteger(obj.budgets.router.max_output_chars)) {
    throw new Error("Invalid policy.json: budgets.router.max_output_chars must be a positive integer");
  }
  if (!isPositiveInteger(obj.budgets.router.max_turns_before_forced_escalation)) {
    throw new Error(
      "Invalid policy.json: budgets.router.max_turns_before_forced_escalation must be a positive integer"
    );
  }

  if (obj.router_stay_min_confidence !== undefined) {
    const v = obj.router_stay_min_confidence;
    if (typeof v !== "number" || v < 0 || v > 1) {
      throw new Error("Invalid policy.json: router_stay_min_confidence must be a number in [0, 1]");
    }
  }
  if (obj.escalate_below_confidence !== undefined) {
    const v = obj.escalate_below_confidence;
    if (typeof v !== "number" || v < 0 || v > 1) {
      throw new Error("Invalid policy.json: escalate_below_confidence must be a number in [0, 1]");
    }
  }

  if (!obj.signals) {
    throw new Error("Invalid policy.json: missing signals");
  }
  assertStringArray(obj.signals.hard_escalate_if_any, "signals.hard_escalate_if_any");
  assertStringArray(obj.signals.soft_escalate_if_any, "signals.soft_escalate_if_any");

  if (
    !isPositiveInteger(obj.signals.long_input_thresholds?.chars) ||
    !isPositiveInteger(obj.signals.long_input_thresholds?.lines)
  ) {
    throw new Error(
      "Invalid policy.json: signals.long_input_thresholds.chars and .lines must be positive integers"
    );
  }

  if (!obj.intent_routing || typeof obj.intent_routing !== "object") {
    throw new Error("Invalid policy.json: missing intent_routing");
  }

  if (!obj.logging) {
    throw new Error("Invalid policy.json: missing logging");
  }
  if (typeof obj.logging.enabled !== "boolean") {
    throw new Error("Invalid policy.json: logging.enabled must be boolean");
  }
  if (obj.logging.format !== "jsonl") {
    throw new Error("Invalid policy.json: logging.format must be jsonl");
  }
  assertStringArray(obj.logging.fields, "logging.fields");
  if (obj.logging.retention_days !== undefined && !isPositiveInteger(obj.logging.retention_days)) {
    throw new Error("Invalid policy.json: logging.retention_days must be a positive integer");
  }
  if (obj.logging.max_file_bytes !== undefined && !isPositiveInteger(obj.logging.max_file_bytes)) {
    throw new Error("Invalid policy.json: logging.max_file_bytes must be a positive integer");
  }
}

export function loadPolicy(policyPath?: string): Policy {
  const pathToUse = policyPath ?? process.env.ROUTER_GOVERNOR_POLICY_PATH ?? "config/policy.json";
  const abs = path.isAbsolute(pathToUse) ? pathToUse : path.join(process.cwd(), pathToUse);
  const raw = fs.readFileSync(abs, "utf8");
  const obj = JSON.parse(raw) as Partial<Policy>;
  validatePolicy(obj);

  if (!obj.logging.path) {
    obj.logging.path = ".openclaw/logs/model-governor.jsonl";
  }
  if (!obj.logging.retention_days) {
    obj.logging.retention_days = 14;
  }
  if (!obj.logging.max_file_bytes) {
    obj.logging.max_file_bytes = 5 * 1024 * 1024;
  }

  return obj;
}
