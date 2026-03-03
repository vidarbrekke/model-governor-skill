import { detectSignals } from "./signals.js";
import { Intent, Policy, RouteRuntimeContext, RoutingDecision } from "./types.js";

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function summarizeForHandoff(prompt: string, maxChars = 240): string {
  const scrubbed = prompt
    .replace(/(api[_ -]?key|secret|password|token)\s*[:=]\s*\S+/gi, "$1:[REDACTED]")
    .trim();
  const firstLine = scrubbed.split(/\r?\n/).find(line => line.trim().length > 0) ?? "";
  return firstLine.slice(0, maxChars);
}

function chooseIntent(signals: string[], prompt: string): { intent: Intent; confidence: number; reasons: string[] } {
  const reasons: string[] = [];

  if (signals.includes("requires_web_freshness")) {
    reasons.push("web_research");
    return { intent: "web_research", confidence: 0.8, reasons };
  }
  if (/differences? between|in plain english|2-sentence explanation/i.test(prompt)) {
    reasons.push("simple_qa");
    return { intent: "simple_qa", confidence: 0.8, reasons };
  }
  if (signals.includes("contains_stack_trace_or_error_log")) {
    reasons.push("debugging");
    return { intent: "debugging", confidence: 0.9, reasons };
  }
  if (/openclaw\.json|models\.json|config|json/i.test(prompt)) {
    reasons.push("config_edit");
    return { intent: "config_edit", confidence: 0.75, reasons };
  }
  if (/(customer-facing|billing mistake|legally cautious|policy doc)/i.test(prompt)) {
    reasons.push("writing_high_stakes");
    return { intent: "writing_high_stakes", confidence: 0.75, reasons };
  }
  if (
    (signals.includes("contains_multi_file_request") && signals.includes("mentions_refactor_architecture")) ||
    /refactor plan|new module boundary|kubernetes manifests|hpa|cost-aware routing system|eval harness|audit .*oauth|security issues/i.test(
      prompt
    )
  ) {
    reasons.push("deep_refactor");
    return { intent: "deep_refactor", confidence: 0.8, reasons };
  }
  // Route test authoring, refactor/extraction, and mocking to codex (earlier escalation for code quality).
  const codingRelated =
    signals.includes("contains_code_block") ||
    signals.includes("contains_patch_request") ||
    signals.includes("mentions_test_suite_or_ci") ||
    /patch-style diff|write a bash script|generate dockerfile|migrate a table|create a skill|build tests|add .* tests?|unit test|mock|logic extraction|extract (to|reusable)|export .* from/i.test(
      prompt
    );
  const needsStrongerModel =
    signals.includes("mentions_test_suite_or_ci") ||
    signals.includes("mentions_test_authoring_or_mocking") ||
    signals.includes("mentions_refactor_architecture") ||
    /logic extraction|extract (to|reusable|shared)|export .* from|mock(ing)?\b|add \w* unit tests?|write \w* unit tests?/i.test(
      prompt
    );
  if (codingRelated && needsStrongerModel) {
    reasons.push("deep_refactor");
    return { intent: "deep_refactor", confidence: 0.78, reasons };
  }
  if (
    signals.includes("contains_code_block") ||
    signals.includes("contains_patch_request") ||
    signals.includes("contains_cli_commands_request") ||
    signals.includes("mentions_database_or_sql") ||
    /patch-style diff|write a bash script|generate dockerfile|migrate a table|create a skill|build tests/i.test(
      prompt
    )
  ) {
    reasons.push("coding");
    return { intent: "coding", confidence: 0.78, reasons };
  }
  if (
    signals.includes("contains_multi_file_request") ||
    /review this github repo|across multiple packages|module boundary|architectural/i.test(prompt)
  ) {
    reasons.push("large_codebase_review");
    return { intent: "large_codebase_review", confidence: 0.75, reasons };
  }
  if (
    signals.includes("mentions_refactor_architecture") ||
    signals.includes("mentions_performance_optimization") ||
    signals.includes("long_input") ||
    /design .*system|routing system|eval harness|audit .*oauth|kubernetes manifests|hpa|security issues|refactor plan/i.test(
      prompt
    )
  ) {
    reasons.push("deep_refactor");
    return { intent: "deep_refactor", confidence: 0.7, reasons };
  }
  if (signals.includes("mentions_uncertainty_or_guessing") || signals.includes("ambiguous_requirements")) {
    reasons.push("triage_only");
    return { intent: "triage_only", confidence: 0.7, reasons };
  }

  reasons.push("simple_qa");
  return { intent: "simple_qa", confidence: 0.65, reasons };
}

function nextEscalationTier(policy: Policy, current: string): string {
  const idx = policy.escalation_tiers.indexOf(current);
  if (idx === -1 || idx === policy.escalation_tiers.length - 1) return policy.fallback_worker_alias;
  return policy.escalation_tiers[idx + 1];
}

export function route(prompt: string, policy: Policy, ctx: RouteRuntimeContext = {}): RoutingDecision {
  const signals = detectSignals(prompt, policy);
  const { intent, confidence, reasons } = chooseIntent(signals, prompt);
  const reasonCodes = [...reasons];
  const constraints: string[] = [];

  const hardEscalate = signals.some(signal => policy.signals.hard_escalate_if_any.includes(signal));
  const softEscalate = signals.some(signal => policy.signals.soft_escalate_if_any.includes(signal));

  let chosenAlias = policy.intent_routing[intent]?.worker ?? policy.default_worker_alias;
  const shouldStayOnRouter = intent === "simple_qa" || intent === "triage_only";

  const stayMin = policy.router_stay_min_confidence ?? 0.6;
  const escalateBelow = policy.escalate_below_confidence ?? 0.55;

  if (shouldStayOnRouter && !hardEscalate && !softEscalate && confidence >= stayMin) {
    chosenAlias = policy.router_alias;
  }

  if (hardEscalate) reasonCodes.push("hard_escalate_signal");
  if (softEscalate) reasonCodes.push("soft_escalate_signal");

  if (chosenAlias === policy.router_alias) {
    if ((ctx.routerToolCalls ?? 0) > policy.budgets.router.max_tool_calls) {
      chosenAlias = policy.default_worker_alias;
      reasonCodes.push("budget_exceeded");
      constraints.push("router_tool_calls_exceeded");
    } else if ((ctx.turnIndex ?? 0) > policy.budgets.router.max_turns_before_forced_escalation) {
      chosenAlias = policy.default_worker_alias;
      reasonCodes.push("budget_exceeded");
      constraints.push("router_turns_exceeded");
    }
  }

  // Keep router conservative on complex requests.
  if (chosenAlias === policy.router_alias && (hardEscalate || confidence < escalateBelow)) {
    chosenAlias = policy.default_worker_alias;
    reasonCodes.push("router_disallowed_action");
  }

  const repeatAt = policy.repeat_failure_rules.repeat_error_signature_escalate_after;
  if (ctx.latestErrorSignature && ctx.previousErrorSignatures) {
    const repeats = ctx.previousErrorSignatures.filter(sig => sig === ctx.latestErrorSignature).length;
    if (repeats + 1 >= repeatAt) {
      chosenAlias = nextEscalationTier(policy, chosenAlias);
      reasonCodes.push("repeat_error_signature");
      constraints.push("escalated_due_to_repeat_error_signature");
    }
  }

  const handoffSummary = summarizeForHandoff(prompt, Math.min(240, policy.budgets.router.max_output_chars));

  return {
    intent,
    chosenAlias,
    reasonCodes: Array.from(new Set(reasonCodes)),
    signals,
    constraints,
    handoffSummary,
    confidence: clamp01(confidence)
  };
}

export function makeHandoffAnnouncement(policy: Policy, decision: RoutingDecision): string | undefined {
  const cfg = policy.handoff_announcement;
  if (!cfg?.enabled) return undefined;
  const primaryReason = decision.reasonCodes[0] ?? decision.intent;
  return `[→ **${decision.chosenAlias}** | intent: ${decision.intent} | reason: ${primaryReason}]`;
}
