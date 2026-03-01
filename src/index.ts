import path from "node:path";
import { appendJsonl } from "./logger.js";
import { loadPolicy } from "./policy.js";
import { makeHandoffAnnouncement, route } from "./router.js";
import { SkillContext, SkillInput, SkillOutput } from "./types.js";

const policy = loadPolicy("config/policy.json");

function isShadowMode(): boolean {
  if (process.env.ROUTER_GOVERNOR_SHADOW_MODE === "1") return true;
  return Boolean((policy as { shadow_mode?: boolean }).shadow_mode);
}

function resolveLogPath(): string {
  const configured = policy.logging.path ?? ".openclaw/logs/model-governor.jsonl";
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function boundedRouterResponse(input: string): string {
  const compact = input.trim();
  if (compact.length < 160) {
    return "I can answer directly, or route this to a worker model for deeper work. What outcome and constraints matter most?";
  }
  return "I can route this to the best worker model. Before handoff, tell me the desired output format (plan, checklist, diff) and any constraints.";
}

export async function handle(input: SkillInput, ctx: SkillContext): Promise<SkillOutput> {
  const decision = route(input.text, policy, {
    turnIndex: input.turnIndex,
    routerToolCalls: input.routerToolCalls,
    previousErrorSignatures: input.previousErrorSignatures,
    latestErrorSignature: input.latestErrorSignature
  });

  if (policy.logging.enabled) {
    const logEntry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      request_id: ctx.requestId ?? null,
      session_id: ctx.sessionId ?? null,
      chosen_alias: decision.chosenAlias,
      intent: decision.intent,
      reason_codes: decision.reasonCodes,
      signals: decision.signals,
      router_tool_calls: input.routerToolCalls ?? 0,
      tokens_in: ctx.tokensIn ?? null,
      tokens_out: ctx.tokensOut ?? null,
      estimated_cost: ctx.estimatedCost ?? null
    };
    if (isShadowMode()) logEntry.shadow_chosen_alias = decision.chosenAlias;
    appendJsonl(resolveLogPath(), logEntry);
  }

  const effectiveAlias = isShadowMode() ? policy.default_worker_alias : decision.chosenAlias;

  if (effectiveAlias === policy.router_alias) {
    const raw = boundedRouterResponse(input.text);
    const text = raw.slice(0, policy.budgets.router.max_output_chars);
    return { mode: "respond", text };
  }

  const announcement = makeHandoffAnnouncement(policy, {
    ...decision,
    chosenAlias: effectiveAlias
  });
  return {
    mode: "handoff",
    chosenAlias: effectiveAlias,
    announcement,
    handoff: {
      intent: decision.intent,
      reason_codes: decision.reasonCodes,
      signals: decision.signals,
      constraints: decision.constraints,
      handoff_summary: decision.handoffSummary,
      original_user_text: input.text
    }
  };
}
