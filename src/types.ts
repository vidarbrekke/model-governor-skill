export type Intent =
  | "simple_qa"
  | "triage_only"
  | "coding"
  | "debugging"
  | "config_edit"
  | "deep_refactor"
  | "large_codebase_review"
  | "writing_high_stakes"
  | "web_research";

export interface Policy {
  version: string;
  router_alias: string;
  default_worker_alias: string;
  fallback_worker_alias: string;
  escalation_tiers: string[];
  budgets: {
    router: {
      max_tool_calls: number;
      max_output_chars: number;
      max_turns_before_forced_escalation: number;
    };
  };
  signals: {
    hard_escalate_if_any: string[];
    soft_escalate_if_any: string[];
    long_input_thresholds: { chars: number; lines: number };
  };
  intent_routing: Record<string, { worker: string; reason?: string }>;
  reason_codes?: string[];
  repeat_failure_rules: {
    repeat_error_signature_escalate_after: number;
    signature_keys: string[];
  };
  disallowed_router_actions?: {
    router_must_not: string[];
    router_should_do: string[];
  };
  handoff_announcement?: {
    enabled: boolean;
    format: string;
    fields: string[];
  };
  logging: {
    enabled: boolean;
    format: "jsonl";
    path?: string;
    fields: string[];
    retention_days?: number;
    max_file_bytes?: number;
  };
  /** When true, log routing decision but always hand off to default_worker_alias. Overridable by ROUTER_GOVERNOR_SHADOW_MODE env. */
  shadow_mode?: boolean;
}

export interface RoutingDecision {
  intent: Intent;
  chosenAlias: string;
  reasonCodes: string[];
  signals: string[];
  constraints: string[];
  handoffSummary: string;
  confidence: number;
}

export interface RouteRuntimeContext {
  turnIndex?: number;
  routerToolCalls?: number;
  previousErrorSignatures?: string[];
  latestErrorSignature?: string;
}

export type SkillInput = {
  text: string;
  routerToolCalls?: number;
  turnIndex?: number;
  previousErrorSignatures?: string[];
  latestErrorSignature?: string;
};

export type SkillContext = {
  sessionId?: string;
  requestId?: string;
  tokensIn?: number;
  tokensOut?: number;
  estimatedCost?: number;
};

export type SkillOutput =
  | { mode: "respond"; text: string }
  | {
      mode: "handoff";
      chosenAlias: string;
      handoff: Record<string, unknown>;
      announcement?: string;
    };
