// Octopus Orchestrator — Consensus Strategy Graph Expander
//
// Expands a single-grip consensus mission into a multi-phase DAG:
//
//   Phase 1: N work grips (one per arm template, parallel)
//   Phase 2: 1 validator grip (checks if all N outputs agree)
//   Total: N + 1 grips
//
// The validator checks whether all models converged on the same answer.
// If they agree, the consensus output is the artifact. If they disagree,
// the validator identifies the disagreement and produces a resolution.
//
// Unlike competitive (pick a winner) or council (merge all), consensus
// requires independent agreement. This is the strongest validation —
// if multiple models independently reach the same conclusion, confidence
// in that conclusion is high.
//
// Use cases: high-stakes decisions, security-critical code, mathematical
// proofs, fact verification, correctness validation.

import type { ArmTemplate } from "../../wire/schema.ts";
import type { ExpandedGraph, GraphNode, CompetitiveExpandOptions } from "./competitive.ts";

// ──────────────────────────────────────────────────────────────────────────
// Validator prompt builder
// ──────────────────────────────────────────────────────────────────────────

function buildValidatorPrompt(
  originalPrompt: string,
  contributors: { runtime: string; gripId: string }[],
): string {
  const outputList = contributors
    .map(
      (c, i) =>
        `Output ${String.fromCharCode(65 + i)} (${c.runtime}):\n` +
        `[Output will be provided from grip: ${c.gripId}]`,
    )
    .join("\n\n");

  return (
    `You are a consensus validator checking whether ${contributors.length} independent ` +
    `models converged on the same answer.\n\n` +
    `ORIGINAL TASK:\n${originalPrompt}\n\n` +
    `INDEPENDENT OUTPUTS:\n${outputList}\n\n` +
    `Analyze the outputs and determine:\n` +
    `1. Do all outputs agree on the core approach and result?\n` +
    `2. Are there any material differences (not just formatting/style)?\n` +
    `3. If they agree, output the consensus result directly.\n` +
    `4. If they disagree, explain the disagreement and produce the strongest resolution.\n\n` +
    `Output format:\n` +
    `- If CONSENSUS: output the agreed-upon result directly, as-is.\n` +
    `- If DISAGREEMENT: start with "DISAGREEMENT:" followed by a brief explanation, ` +
    `then "RESOLUTION:" followed by the best resolution incorporating the strongest arguments.\n\n` +
    `Prefer consensus. Only flag disagreement when the outputs are materially different ` +
    `in approach, logic, or correctness — not just in style or formatting.`
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Graph expander
// ──────────────────────────────────────────────────────────────────────────

/**
 * Expand a single grip into a consensus validation graph.
 *
 * Given 3 arm templates (A, B, C) and grip "task":
 *   work-A, work-B, work-C       (phase 1, parallel)
 *   validate (depends on all)     (phase 2)
 */
export function expandConsensusGraph(opts: CompetitiveExpandOptions): ExpandedGraph {
  const { gripId, prompt, armTemplates } = opts;
  const validatorBase = opts.judgeTemplate ?? armTemplates[0];

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

  // Phase 2: validator grip
  const validatorId = `${gripId}:validate`;
  graph.push({ grip_id: validatorId, depends_on: [...workGripIds] });

  const contributors = armTemplates.map((t) => ({
    runtime: t.runtime_name,
    gripId: `${gripId}:work:${t.runtime_name}`,
  }));
  const validatorPrompt = buildValidatorPrompt(prompt, contributors);
  armTemplatesByGrip.set(validatorId, [
    { ...validatorBase, runtime_name: "validator", initial_input: validatorPrompt },
  ]);

  return { graph, armTemplatesByGrip };
}
