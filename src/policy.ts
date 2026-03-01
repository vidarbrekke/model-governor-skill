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
}

export function loadPolicy(policyPath: string): Policy {
  const abs = path.isAbsolute(policyPath) ? policyPath : path.join(process.cwd(), policyPath);
  const raw = fs.readFileSync(abs, "utf8");
  const obj = JSON.parse(raw) as Partial<Policy>;
  validatePolicy(obj);

  if (!obj.logging.path) {
    obj.logging.path = ".openclaw/logs/model-governor.jsonl";
  }

  return obj;
}
