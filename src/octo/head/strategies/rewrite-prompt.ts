// Strategy helper — rewrite runtime_options.args so the prompt argument
// reflects the framed round prompt instead of the raw original task.
//
// Background: strategy expanders (collaborative / competitive / council /
// consensus) generate framed prompts per round/phase (e.g.,
// "You are the reviewer in round 2/3. ORIGINAL TASK: ... PRIOR OUTPUT
// (from X): [Output will be provided from grip: X] Review..."). They
// store that framed prompt in `template.initial_input`.
//
// HOWEVER, the adapter layer (pty_tmux) builds the actual CLI invocation
// from `template.runtime_options.args`, not from `initial_input`. Those
// args still contain the raw original task from the CLI's buildArgs
// step — so without this rewrite, the framed prompt never reaches the
// CLI and each round/phase runs the original task independently. This
// was the Bug 2 diagnosed via the 2026-04-12 teleconference (meeting
// mtg_1776010525498_a4d275) and reproduced on mission
// mis-a58fc01e-60a5-43c9-b9ef-134cb42219bb.
//
// The rewrite is literal-substring replacement — we replace any arg
// whose content `includes()` the raw original prompt with the framed
// version. This is safe because each of the known runtime profiles
// passes the prompt as a standalone arg:
//
//   claude:   ["-p", "<prompt>", "--dangerously-skip-permissions"]
//   codex:    ["exec", "--full-auto", "--skip-git-repo-check", "<prompt>"]
//   gemini:   ["-p", "<prompt>", "--approval-mode", "yolo"]
//   openclaw: ["agent", "--agent", "main", "--message", "<prompt>"]
//   aider:    ["--yes", "--message", "<prompt>"]
//
// For a phase-2 or phase-3 arm whose framed prompt still contains the
// placeholder `[Output will be provided from grip: X]`, the cascade
// handler in NodeAgent.transitionArm resolves that placeholder to the
// actual dependency output just before spawning the arm, via the same
// rewriteArgsForPrompt primitive below.

/**
 * Return a new runtime_options object whose args array has any arg
 * containing `originalPrompt` replaced with `framedPrompt`. Generic in
 * the runtime_options type so the caller preserves its own static
 * shape — strategies pass typed `ArmTemplate["runtime_options"]`
 * unions (cli_exec / pty_tmux / subagent / acp) and get the same type
 * back. Without generics, TypeScript rejects the reassignment because
 * two different structural unions exist with overlapping-but-distinct
 * shapes.
 *
 * Idempotent: calling with `originalPrompt === framedPrompt` is a no-op.
 * Safe: returns the input unchanged when `args` is not an array.
 */
export function rewriteArgsForPrompt<T>(
  runtimeOptions: T,
  originalPrompt: string | undefined,
  framedPrompt: string,
): T {
  if (!runtimeOptions || typeof runtimeOptions !== "object") {
    return runtimeOptions;
  }
  if (!originalPrompt || originalPrompt === framedPrompt) {
    return runtimeOptions;
  }
  const asRecord = runtimeOptions as unknown as Record<string, unknown>;
  const args = asRecord.args;
  if (!Array.isArray(args)) {
    return runtimeOptions;
  }
  const rewritten = args.map((a) => {
    if (typeof a !== "string") {
      return a;
    }
    if (a === originalPrompt) {
      return framedPrompt;
    }
    // Handle the embedded-substring case too (unusual but safe).
    if (a.includes(originalPrompt)) {
      return a.split(originalPrompt).join(framedPrompt);
    }
    return a;
  });
  return { ...asRecord, args: rewritten } as unknown as T;
}

/**
 * Resolve the `[Output will be provided from grip: X]` placeholder in a
 * framed prompt string using a map of dependency-grip-id → output. Used
 * by the cascade handler when spawning a dependent arm.
 */
export function resolveDependencyPlaceholders(
  framedPrompt: string,
  depOutputs: Record<string, string>,
): string {
  let resolved = framedPrompt;
  for (const [depId, output] of Object.entries(depOutputs)) {
    resolved = resolved.split(`[Output will be provided from grip: ${depId}]`).join(output);
  }
  return resolved;
}
