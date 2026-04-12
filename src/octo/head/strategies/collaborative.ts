// Octopus Orchestrator — Collaborative Strategy Graph Expander
//
// Expands a single-grip collaborative mission into a sequential DAG:
//
//   Round 1: Model A drafts the solution
//   Round 2: Model B receives A's output, critiques and improves
//   Round 3: Model C receives B's output, refines to final
//   Total: N grips (sequential chain)
//
// Each model builds on the previous model's work. The final model's
// output is the artifact. Unlike competitive, models cooperate rather
// than compete — each iteration should improve the result.
//
// Use cases: iterative refinement, code review chains, progressive
// enhancement, draft → critique → polish workflows.

import type { ArmTemplate } from "../../wire/schema.ts";
import type { ExpandedGraph, GraphNode, CompetitiveExpandOptions } from "./competitive.ts";
import { rewriteArgsForPrompt } from "./rewrite-prompt.ts";

// ──────────────────────────────────────────────────────────────────────────
// Round prompt builders
// ──────────────────────────────────────────────────────────────────────────

function buildDraftPrompt(originalPrompt: string): string {
  return (
    `You are the first contributor in a collaborative chain. ` +
    `Produce a solid initial draft.\n\n` +
    `TASK:\n${originalPrompt}\n\n` +
    `Output your solution directly. The next contributor will review ` +
    `and improve your work.`
  );
}

function buildRefinePrompt(
  originalPrompt: string,
  round: number,
  totalRounds: number,
  priorRuntime: string,
  priorGripId: string,
): string {
  const isLast = round === totalRounds;
  const role = isLast ? "final polisher" : "reviewer and improver";

  return (
    `You are the ${role} in round ${round}/${totalRounds} of a collaborative chain.\n\n` +
    `ORIGINAL TASK:\n${originalPrompt}\n\n` +
    `PRIOR OUTPUT (from ${priorRuntime}):\n` +
    `[Output will be provided from grip: ${priorGripId}]\n\n` +
    (isLast
      ? `This is the FINAL round. Produce the definitive, polished output. ` +
        `Fix any remaining issues, improve clarity, and ensure completeness. ` +
        `Output only the final result.`
      : `Review the prior output. Identify weaknesses, gaps, or improvements. ` +
        `Produce an improved version that addresses the issues while preserving ` +
        `what works well. Output the improved result directly.`)
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Graph expander
// ──────────────────────────────────────────────────────────────────────────

/**
 * Expand a single grip into a collaborative sequential chain.
 *
 * Given 3 arm templates (A, B, C) and grip "task":
 *   round-1:A (draft)         → depends on nothing
 *   round-2:B (review A)      → depends on round-1
 *   round-3:C (polish B)      → depends on round-2
 */
export function expandCollaborativeGraph(opts: CompetitiveExpandOptions): ExpandedGraph {
  const { gripId, prompt, armTemplates } = opts;

  const graph: GraphNode[] = [];
  const armTemplatesByGrip = new Map<string, ArmTemplate[]>();
  const totalRounds = armTemplates.length;

  let prevGripId: string | null = null;

  for (let i = 0; i < armTemplates.length; i++) {
    const tmpl = armTemplates[i];
    const round = i + 1;
    const roundId = `${gripId}:round-${round}:${tmpl.runtime_name}`;

    // Each round depends on the previous round
    const deps = prevGripId ? [prevGripId] : [];
    graph.push({ grip_id: roundId, depends_on: deps });

    // Build the appropriate prompt
    let roundPrompt: string;
    if (i === 0) {
      roundPrompt = buildDraftPrompt(prompt);
    } else {
      const priorRuntime = armTemplates[i - 1].runtime_name;
      roundPrompt = buildRefinePrompt(prompt, round, totalRounds, priorRuntime, prevGripId!);
    }

    // Rewrite runtime_options.args so the CLI invocation receives the
    // framed round prompt, not the raw original task. Phase-1 arms
    // with no dependencies bake the draft framing directly. Phase-2+
    // arms retain the `[Output will be provided from grip: X]`
    // placeholder in args; the NodeAgent cascade handler resolves
    // it against the completed dependency's output just before
    // spawning.
    const rewrittenRuntimeOptions =
      rewriteArgsForPrompt(tmpl.runtime_options, prompt, roundPrompt) ?? tmpl.runtime_options;

    armTemplatesByGrip.set(roundId, [
      {
        ...tmpl,
        initial_input: roundPrompt,
        runtime_options: rewrittenRuntimeOptions,
      },
    ]);

    prevGripId = roundId;
  }

  return { graph, armTemplatesByGrip };
}
