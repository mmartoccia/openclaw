// Classify arm failure reasons from captured CLI output.
//
// NodeAgent transitions arms to `failed` with a `reason` field in the
// event payload. Historically that's always been `exit_code_<N>` or
// `session_not_found_on_poll`, which is useless to operators when the
// real cause is "claude account needs to re-login" or "codex token
// expired". This module scans captured stdout/stderr for known failure
// signatures and returns a more descriptive reason code when it matches.
//
// Return value is a stable code (e.g., `auth_required`) — formatting is
// the caller's responsibility. Unknown failures fall back to null so
// the caller can keep its existing `exit_code_N` reason.

export type FailureReasonCode =
  | "auth_required"
  | "rate_limited"
  | "network_error"
  | "cli_not_found"
  | "out_of_memory";

const SIGNATURES: Array<{ code: FailureReasonCode; patterns: RegExp[] }> = [
  {
    code: "auth_required",
    patterns: [
      /401\s+unauthorized/i,
      /\bnot\s+authenticated\b/i,
      /\bauthentication\s+(failed|required|expired)\b/i,
      /\bre-?authenticate\b/i,
      /please\s+(log\s*in|sign\s*in)/i,
      /\b(api[_\s-]?key|token)\s+(expired|invalid|missing)\b/i,
      /invalid\s+credentials/i,
      /session\s+expired/i,
      // codex-specific
      /openai\s+api\s+key/i,
      // claude-specific
      /anthropic\s+api\s+key/i,
    ],
  },
  {
    code: "rate_limited",
    patterns: [
      /429\s+too\s+many\s+requests/i,
      /\brate[_\s-]?limit(ed|ing)?\b/i,
      /quota\s+exceeded/i,
    ],
  },
  {
    code: "network_error",
    patterns: [
      /ECONNREFUSED/i,
      /ENOTFOUND/i,
      /ETIMEDOUT/i,
      /getaddrinfo\s+failed/i,
      /network\s+(error|unreachable)/i,
    ],
  },
  {
    code: "cli_not_found",
    patterns: [/command\s+not\s+found/i, /: not found/i, /no such file or directory/i],
  },
  {
    code: "out_of_memory",
    patterns: [/\bOOM\b/, /out of memory/i, /JavaScript heap out of memory/i, /Killed$/m],
  },
];

/**
 * Inspect captured output for known failure signatures. Returns the
 * first matching reason code, or null if no signature matches. Called
 * by NodeAgent before transitioning an arm to `failed` so operators
 * see `auth_required` instead of `exit_code_1`.
 */
export function classifyFailure(output: string): FailureReasonCode | null {
  if (!output) {
    return null;
  }
  // Inspect only the tail — failure messages usually land at the end
  // and scanning the full output is wasteful for long runs.
  const tail = output.length > 8192 ? output.slice(-8192) : output;
  for (const sig of SIGNATURES) {
    for (const pattern of sig.patterns) {
      if (pattern.test(tail)) {
        return sig.code;
      }
    }
  }
  return null;
}
