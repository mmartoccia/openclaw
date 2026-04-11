// Octopus Orchestrator — Council Strategy Graph Expander
//
// Expands a single-grip council mission into a multi-phase DAG:
//
//   Phase 1: N work grips (one per arm template, parallel)
//   Phase 2: 1 synthesizer grip (merges all N outputs into a unified result)
//   Total: N + 1 grips
//
// Unlike competitive, council has no losers. Every model's contribution
// is incorporated into the final output. The synthesizer combines the
// best ideas from each model's perspective.
//
// Use cases: complex design decisions, architecture reviews,
// multi-perspective analysis, brainstorming.

import type { ArmTemplate } from "../../wire/schema.ts";
import type { ExpandedGraph, GraphNode, CompetitiveExpandOptions } from "./competitive.ts";

// ──────────────────────────────────────────────────────────────────────────
// Synthesizer prompt builder
// ──────────────────────────────────────────────────────────────────────────

function buildSynthesizerPrompt(
  originalPrompt: string,
  contributors: { runtime: string; gripId: string }[],
): string {
  const contributionList = contributors
    .map(
      (c, i) =>
        `Contribution ${String.fromCharCode(65 + i)} (${c.runtime}):\n` +
        `[Output will be provided from grip: ${c.gripId}]`,
    )
    .join("\n\n");

  return (
    `You are a synthesizer combining ${contributors.length} independent contributions into a single unified output.\n\n` +
    `ORIGINAL TASK:\n${originalPrompt}\n\n` +
    `CONTRIBUTIONS:\n${contributionList}\n\n` +
    `Your job is to produce a SINGLE unified output that:\n` +
    `1. Incorporates the best ideas from each contribution\n` +
    `2. Resolves any contradictions by choosing the stronger approach\n` +
    `3. Fills gaps where one contribution covers something others missed\n` +
    `4. Maintains consistency and coherence in the final output\n\n` +
    `Do NOT list the contributions separately. Produce one cohesive result ` +
    `as if a single expert wrote it, drawing from all perspectives.\n\n` +
    `Output the synthesized result directly — no meta-commentary, no attribution, ` +
    `just the unified solution.`
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Graph expander
// ──────────────────────────────────────────────────────────────────────────

/**
 * Expand a single grip into a council graph.
 *
 * Given 3 arm templates (A, B, C) and grip "task":
 *   work-A, work-B, work-C       (phase 1, parallel)
 *   synthesize (depends on all)   (phase 2)
 */
export function expandCouncilGraph(opts: CompetitiveExpandOptions): ExpandedGraph {
  const { gripId, prompt, armTemplates } = opts;
  const synthBase = opts.judgeTemplate ?? armTemplates[0];

  const graph: GraphNode[] = [];
  const armTemplatesByGrip = new Map<string, ArmTemplate[]>();

  // Phase 1: work grips (one per arm template)
  const workGripIds: string[] = [];
  for (const tmpl of armTemplates) {
    const workId = `${gripId}:work:${tmpl.runtime_name}`;
    workGripIds.push(workId);
    graph.push({ grip_id: workId, depends_on: [] });
    armTemplatesByGrip.set(workId, [{ ...tmpl, initial_input: prompt }]);
  }

  // Phase 2: synthesizer grip
  const synthId = `${gripId}:synthesize`;
  graph.push({ grip_id: synthId, depends_on: [...workGripIds] });

  const contributors = armTemplates.map((t) => ({
    runtime: t.runtime_name,
    gripId: `${gripId}:work:${t.runtime_name}`,
  }));
  const synthPrompt = buildSynthesizerPrompt(prompt, contributors);
  armTemplatesByGrip.set(synthId, [
    { ...synthBase, runtime_name: "synthesizer", initial_input: synthPrompt },
  ]);

  return { graph, armTemplatesByGrip };
}
