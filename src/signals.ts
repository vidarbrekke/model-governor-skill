import { Policy } from "./types.js";

function maybePush(condition: boolean, key: string, out: string[]): void {
  if (condition) out.push(key);
}

export function detectSignals(prompt: string, policy: Policy): string[] {
  const signals: string[] = [];
  const lineCount = prompt.split(/\r?\n/).length;
  const p = prompt;

  maybePush(p.includes("```"), "contains_code_block", signals);
  maybePush(/patch|\bdiff\b|unified diff|git diff/i.test(p), "contains_patch_request", signals);
  maybePush(
    /(stack trace|traceback|exception|error:|panic:|failed\b)/i.test(p),
    "contains_stack_trace_or_error_log",
    signals
  );
  maybePush(
    /(across multiple|multiple files|8 files|many files|entire repo|whole repo)/i.test(p),
    "contains_multi_file_request",
    signals
  );
  maybePush(
    /(^|\s)(dockerfile|docker-compose|kubernetes|helm|k8s)\b/i.test(p),
    "mentions_kubernetes_or_docker",
    signals
  );
  maybePush(
    /(\bSQL\b|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|migrate|migration|rollback)/i.test(p),
    "mentions_database_or_sql",
    signals
  );
  maybePush(
    /(\bOAuth\b|\bOIDC\b|\bSAML\b|\bJWT\b|refresh token|client secret)/i.test(p),
    "mentions_oauth_or_auth_flows",
    signals
  );
  maybePush(
    /(optimi[sz]e|performance|latency|throughput|benchmark)/i.test(p),
    "mentions_performance_optimization",
    signals
  );
  maybePush(
    /(refactor|architecture|module boundary|restructure)/i.test(p),
    "mentions_refactor_architecture",
    signals
  );
  maybePush(
    /(\bCI\b|GitHub Actions|pipeline|unit tests|integration tests|vitest|jest)/i.test(p),
    "mentions_test_suite_or_ci",
    signals
  );
  maybePush(
    /(shell script|write .*script|generate .*script|bash script|powershell script)/i.test(p),
    "contains_cli_commands_request",
    signals
  );
  maybePush(
    /(password|api key|secret|credential|token\b|oauth flow security|security issues)/i.test(p),
    "contains_security_sensitive_request",
    signals
  );
  maybePush(/(not sure what I need|guess|unclear|maybe)/i.test(p), "mentions_uncertainty_or_guessing", signals);
  maybePush(/(\blatest\b|\btoday\b|\bthis week\b|\bcurrent\b|\brecent\b|last \d+ days)/i.test(p), "requires_web_freshness", signals);
  maybePush(/(and then|two goals|secondly|thirdly)/i.test(p), "more_than_one_goal", signals);
  maybePush(/(unclear|ambiguous|either this or that|not sure)/i.test(p), "ambiguous_requirements", signals);
  maybePush(/(debug|debugging|tests started failing|failing tests|root cause|error logs?)/i.test(p), "contains_stack_trace_or_error_log", signals);
  maybePush(/(<LOG>|pasted log|logs?\.\.\.)/i.test(p), "contains_stack_trace_or_error_log", signals);

  maybePush(
    p.length > policy.signals.long_input_thresholds.chars ||
      lineCount > policy.signals.long_input_thresholds.lines,
    "long_input",
    signals
  );

  return Array.from(new Set(signals));
}
