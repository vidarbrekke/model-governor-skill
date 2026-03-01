import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { loadPolicy } from "../src/policy.js";
import { route } from "../src/router.js";

type Case = {
  id: string;
  prompt: string;
  expected_alias: string;
  expected_intent: string;
};

describe("routing cases", () => {
  const policy = loadPolicy("config/policy.json");
  const lines = fs.readFileSync("tests/cases.jsonl", "utf8").trim().split("\n");
  const cases = lines.map(line => JSON.parse(line) as Case);

  for (const testCase of cases) {
    it(testCase.id, () => {
      const decision = route(testCase.prompt, policy);
      expect(decision.chosenAlias).toBe(testCase.expected_alias);
      expect(decision.intent).toBe(testCase.expected_intent);
    });
  }
});

describe("routing edge cases", () => {
  const policy = loadPolicy("config/policy.json");

  it("empty prompt defaults to simple_qa and worker alias (conservative)", () => {
    const decision = route("", policy);
    expect(decision.intent).toBe("simple_qa");
    expect(["router", "default"]).toContain(decision.chosenAlias);
    expect(decision.reasonCodes.length).toBeGreaterThan(0);
  });

  it("whitespace-only prompt is treated as simple_qa", () => {
    const decision = route("   \n\t  ", policy);
    expect(decision.intent).toBe("simple_qa");
    expect(decision.signals).not.toContain("long_input");
  });

  it("prompt over long_input chars threshold gets long_input signal and escalates", () => {
    const long = "x".repeat(policy.signals.long_input_thresholds.chars + 1000);
    const decision = route(long, policy);
    expect(decision.signals).toContain("long_input");
    expect(decision.chosenAlias).not.toBe(policy.router_alias);
  });

  it("prompt over long_input lines threshold gets long_input signal", () => {
    const lines = Array.from({ length: policy.signals.long_input_thresholds.lines + 50 }, () => "line").join("\n");
    const decision = route(lines, policy);
    expect(decision.signals).toContain("long_input");
  });

  it("router over tool-call budget is forced to default with budget_exceeded", () => {
    const decision = route("What is OpenClaw? 2 sentences.", policy, {
      routerToolCalls: policy.budgets.router.max_tool_calls + 1
    });
    expect(decision.chosenAlias).toBe(policy.default_worker_alias);
    expect(decision.reasonCodes).toContain("budget_exceeded");
    expect(decision.constraints).toContain("router_tool_calls_exceeded");
  });

  it("repeat error signature escalates to next tier", () => {
    const sig = "err:ENOENT:read_file";
    const decision = route("Fix this typo in the config.", policy, {
      previousErrorSignatures: [sig],
      latestErrorSignature: sig
    });
    expect(decision.reasonCodes).toContain("repeat_error_signature");
    expect(decision.chosenAlias).toBe(policy.escalation_tiers[1]); // codex
  });

  it("handoff summary is redacted and length-bounded", () => {
    const decision = route("Secret: api_key=sk-12345\nSecond line.", policy);
    expect(decision.handoffSummary.length).toBeLessThanOrEqual(policy.budgets.router.max_output_chars);
    expect(decision.handoffSummary).not.toMatch(/sk-\d+/);
  });

  it("simple_qa with no hard signals can stay on router", () => {
    const decision = route("What is OpenClaw? Give me a 2-sentence explanation.", policy);
    expect(decision.chosenAlias).toBe(policy.router_alias);
    expect(decision.intent).toBe("simple_qa");
  });
});
