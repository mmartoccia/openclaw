// Octopus Orchestrator — Competitive Strategy Graph Expander
//
// Expands a single-grip competitive mission into a multi-phase DAG:
//
// competitive (round-robin peer review):
//   Phase 1: N work grips (one per arm template, parallel)
//   Phase 2: N judge grips (each reviews the other N-1 outputs, parallel)
//   Phase 3: 1 verdict grip (aggregates all judge scores, picks winner)
//   Total: 2N + 1 grips
//
// competitive_single_judge:
//   Phase 1: N work grips (one per arm template, parallel)
//   Phase 2: 1 judge grip (reviews all N outputs, picks winner)
//   Total: N + 1 grips
//
// The strategy generates the grip graph and the judge prompts.
// Judge arm templates reuse the first arm template's config by default
// (the judge model can be overridden via judge_template on the spec).

import type { ArmTemplate } from "../../wire/schema.ts";
import { rewriteArgsForPrompt } from "./rewrite-prompt.ts";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface GraphNode {
  grip_id: string;
  depends_on: string[];
}

export interface ExpandedGraph {
  graph: GraphNode[];
  /** Arm templates for each grip, keyed by grip_id. */
  armTemplatesByGrip: Map<string, ArmTemplate[]>;
}

export interface CompetitiveExpandOptions {
  /** The original grip_id from the user's spec. */
  gripId: string;
  /** The task prompt. */
  prompt: string;
  /** Arm templates — one per competing model. */
  armTemplates: ArmTemplate[];
  /** Optional: dedicated judge template. Defaults to first arm template. */
  judgeTemplate?: ArmTemplate;
  /** Optional: dedicated verdict template. Defaults to judge or first. */
  verdictTemplate?: ArmTemplate;
}

// ──────────────────────────────────────────────────────────────────────────
// Judge prompt builders
// ──────────────────────────────────────────────────────────────────────────

function buildPeerJudgePrompt(
  originalPrompt: string,
  judgeRuntime: string,
  reviews: { runtime: string; gripId: string }[],
): string {
  const reviewList = reviews
    .map(
      (r, i) =>
        `Solution ${String.fromCharCode(65 + i)} (${r.runtime}):\n` +
        `[Output will be provided from grip: ${r.gripId}]`,
    )
    .join("\n\n");

  return (
    `You are a peer reviewer in a competitive evaluation. You are "${judgeRuntime}".\n\n` +
    `ORIGINAL TASK:\n${originalPrompt}\n\n` +
    `SOLUTIONS TO REVIEW:\n${reviewList}\n\n` +
    `Evaluate each solution on:\n` +
    `1. Correctness — does it solve the task accurately?\n` +
    `2. Completeness — does it address all aspects?\n` +
    `3. Quality — code quality, clarity, elegance\n` +
    `4. Efficiency — resource usage, performance considerations\n\n` +
    `Output your evaluation as JSON:\n` +
    `{\n` +
    `  "judge": "${judgeRuntime}",\n` +
    `  "scores": {\n` +
    reviews
      .map(
        (r) =>
          `    "${r.runtime}": { "correctness": 0-10, "completeness": 0-10, "quality": 0-10, "efficiency": 0-10, "total": 0-40 }`,
      )
      .join(",\n") +
    `\n  },\n` +
    `  "reasoning": "brief explanation of scores",\n` +
    `  "recommended_winner": "runtime_name of the better solution"\n` +
    `}`
  );
}

function buildSingleJudgePrompt(
  originalPrompt: string,
  contestants: { runtime: string; gripId: string }[],
): string {
  const solutionList = contestants
    .map(
      (c, i) =>
        `Solution ${String.fromCharCode(65 + i)} (${c.runtime}):\n` +
        `[Output will be provided from grip: ${c.gripId}]`,
    )
    .join("\n\n");

  return (
    `You are the judge in a competitive evaluation of ${contestants.length} solutions.\n\n` +
    `ORIGINAL TASK:\n${originalPrompt}\n\n` +
    `SOLUTIONS:\n${solutionList}\n\n` +
    `Evaluate each solution on:\n` +
    `1. Correctness — does it solve the task accurately?\n` +
    `2. Completeness — does it address all aspects?\n` +
    `3. Quality — code quality, clarity, elegance\n` +
    `4. Efficiency — resource usage, performance considerations\n\n` +
    `Output your evaluation as JSON:\n` +
    `{\n` +
    `  "scores": {\n` +
    contestants
      .map(
        (c) =>
          `    "${c.runtime}": { "correctness": 0-10, "completeness": 0-10, "quality": 0-10, "efficiency": 0-10, "total": 0-40 }`,
      )
      .join(",\n") +
    `\n  },\n` +
    `  "winner": "runtime_name",\n` +
    `  "ranking": ["first", "second", "third"],\n` +
    `  "reasoning": "detailed explanation"\n` +
    `}`
  );
}

function buildVerdictPrompt(
  originalPrompt: string,
  contestants: string[],
  judgeCount: number,
): string {
  return (
    `You are the final arbiter aggregating ${judgeCount} peer review scores.\n\n` +
    `ORIGINAL TASK:\n${originalPrompt}\n\n` +
    `CONTESTANTS: ${contestants.join(", ")}\n\n` +
    `Each contestant was reviewed by the other ${judgeCount > 1 ? judgeCount + " contestants" : "contestant"}. ` +
    `Collect the judge outputs from the dependent grips, aggregate the scores, and produce the final verdict.\n\n` +
    `Output JSON:\n` +
    `{\n` +
    `  "final_scores": { "runtime": total_aggregate_score },\n` +
    `  "winner": "runtime_name",\n` +
    `  "ranking": ["first", "second", ...],\n` +
    `  "elo_deltas": { "runtime": +/- delta },\n` +
    `  "reasoning": "aggregation summary"\n` +
    `}`
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Graph expanders
// ──────────────────────────────────────────────────────────────────────────

/**
 * Expand a single grip into a round-robin competitive graph.
 *
 * Given 3 arm templates (A, B, C) and grip "task":
 *   work-A, work-B, work-C          (phase 1, parallel)
 *   judge-A (reviews B+C)           (phase 2, depends on all work)
 *   judge-B (reviews A+C)
 *   judge-C (reviews A+B)
 *   verdict (depends on all judges) (phase 3)
 */
export function expandCompetitiveGraph(opts: CompetitiveExpandOptions): ExpandedGraph {
  const { gripId, prompt, armTemplates } = opts;
  const judgeBase = opts.judgeTemplate ?? armTemplates[0];
  const verdictBase = opts.verdictTemplate ?? judgeBase;

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

  // Phase 2: judge grips (each reviews the other N-1)
  const judgeGripIds: string[] = [];
  for (const tmpl of armTemplates) {
    const judgeId = `${gripId}:judge:${tmpl.runtime_name}`;
    judgeGripIds.push(judgeId);
    graph.push({ grip_id: judgeId, depends_on: [...workGripIds] });

    // This judge reviews everyone except itself
    const reviews = armTemplates
      .filter((t) => t.runtime_name !== tmpl.runtime_name)
      .map((t) => ({
        runtime: t.runtime_name,
        gripId: `${gripId}:work:${t.runtime_name}`,
      }));

    const judgePrompt = buildPeerJudgePrompt(prompt, tmpl.runtime_name, reviews);
    const judgeRuntimeOptions =
      rewriteArgsForPrompt(judgeBase.runtime_options, prompt, judgePrompt) ??
      judgeBase.runtime_options;
    armTemplatesByGrip.set(judgeId, [
      {
        ...judgeBase,
        runtime_name: tmpl.runtime_name,
        initial_input: judgePrompt,
        runtime_options: judgeRuntimeOptions,
      },
    ]);
  }

  // Phase 3: verdict grip
  const verdictId = `${gripId}:verdict`;
  graph.push({ grip_id: verdictId, depends_on: [...judgeGripIds] });
  const verdictPrompt = buildVerdictPrompt(
    prompt,
    armTemplates.map((t) => t.runtime_name),
    armTemplates.length,
  );
  const verdictRuntimeOptions =
    rewriteArgsForPrompt(verdictBase.runtime_options, prompt, verdictPrompt) ??
    verdictBase.runtime_options;
  armTemplatesByGrip.set(verdictId, [
    {
      ...verdictBase,
      runtime_name: "verdict",
      initial_input: verdictPrompt,
      runtime_options: verdictRuntimeOptions,
    },
  ]);

  return { graph, armTemplatesByGrip };
}

/**
 * Expand a single grip into a single-judge competitive graph.
 *
 * Given 3 arm templates and grip "task":
 *   work-A, work-B, work-C   (phase 1, parallel)
 *   judge (reviews all 3)     (phase 2, depends on all work)
 */
export function expandSingleJudgeGraph(opts: CompetitiveExpandOptions): ExpandedGraph {
  const { gripId, prompt, armTemplates } = opts;
  const judgeBase = opts.judgeTemplate ?? armTemplates[0];

  const graph: GraphNode[] = [];
  const armTemplatesByGrip = new Map<string, ArmTemplate[]>();

  // Phase 1: work grips
  const workGripIds: string[] = [];
  for (const tmpl of armTemplates) {
    const workId = `${gripId}:work:${tmpl.runtime_name}`;
    workGripIds.push(workId);
    graph.push({ grip_id: workId, depends_on: [] });
    armTemplatesByGrip.set(workId, [{ ...tmpl, initial_input: prompt }]);
  }

  // Phase 2: single judge
  const judgeId = `${gripId}:judge`;
  graph.push({ grip_id: judgeId, depends_on: [...workGripIds] });

  const contestants = armTemplates.map((t) => ({
    runtime: t.runtime_name,
    gripId: `${gripId}:work:${t.runtime_name}`,
  }));
  const judgePrompt = buildSingleJudgePrompt(prompt, contestants);
  const judgeRuntimeOptions =
    rewriteArgsForPrompt(judgeBase.runtime_options, prompt, judgePrompt) ??
    judgeBase.runtime_options;
  armTemplatesByGrip.set(judgeId, [
    {
      ...judgeBase,
      runtime_name: "judge",
      initial_input: judgePrompt,
      runtime_options: judgeRuntimeOptions,
    },
  ]);

  return { graph, armTemplatesByGrip };
}
