// EloService tests — covers pairwise update math, ties, winner-selection,
// persistence, and parseVerdictForElo format tolerance.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EloService, parseVerdictForElo } from "./elo.ts";
import { closeOctoRegistry, openOctoRegistry } from "./storage/migrate.ts";

let tempDir: string;
let db: DatabaseSync;
let elo: EloService;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-elo-test-"));
  db = openOctoRegistry({ path: path.join(tempDir, "registry.sqlite") });
  elo = new EloService(db);
});

afterEach(() => {
  try {
    closeOctoRegistry(db);
  } catch {
    // already closed
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("EloService.getRating", () => {
  it("seeds new runtimes at 1500", () => {
    const r = elo.getRating("claude");
    expect(r.runtime_name).toBe("claude");
    expect(r.rating).toBe(1500);
    expect(r.games).toBe(0);
  });

  it("returns the same row on subsequent reads", () => {
    elo.getRating("claude");
    const again = elo.getRating("claude");
    expect(again.rating).toBe(1500);
  });
});

describe("EloService.recordGame — pairwise", () => {
  it("updates ratings for a 2-player game (winner gains, loser loses)", () => {
    const game = elo.recordGame({
      game_id: "g1",
      mission_id: "m1",
      grip_id: "grip1",
      results: [
        { runtime: "claude", rank: 1 },
        { runtime: "codex", rank: 2 },
      ],
    });
    const winner = game.results.find((r) => r.runtime === "claude")!;
    const loser = game.results.find((r) => r.runtime === "codex")!;
    expect(winner.rating_after).toBeGreaterThan(winner.rating_before);
    expect(loser.rating_after).toBeLessThan(loser.rating_before);
    // K=32, equal pre-ratings → each shifts by 16.
    expect(winner.delta).toBeCloseTo(16, 5);
    expect(loser.delta).toBeCloseTo(-16, 5);
    expect(game.winner_runtime).toBe("claude");
  });

  it("handles 3-way ranking with pairwise updates", () => {
    const game = elo.recordGame({
      game_id: "g1",
      mission_id: "m1",
      grip_id: "grip1",
      results: [
        { runtime: "claude", rank: 1 },
        { runtime: "codex", rank: 2 },
        { runtime: "gemini", rank: 3 },
      ],
    });
    // With equal pre-ratings and K=32:
    //   claude beats both → +16 + +16 = +32
    //   codex: loses to claude (-16), beats gemini (+16) = 0
    //   gemini: loses to both (-16 + -16) = -32
    const claudeResult = game.results.find((r) => r.runtime === "claude")!;
    const codexResult = game.results.find((r) => r.runtime === "codex")!;
    const geminiResult = game.results.find((r) => r.runtime === "gemini")!;
    expect(claudeResult.delta).toBeCloseTo(32, 5);
    expect(codexResult.delta).toBeCloseTo(0, 5);
    expect(geminiResult.delta).toBeCloseTo(-32, 5);
    expect(game.winner_runtime).toBe("claude");
  });

  it("treats equal ranks as a tie (0.5/0.5) and reports no single winner", () => {
    const game = elo.recordGame({
      game_id: "g1",
      mission_id: "m1",
      grip_id: "grip1",
      results: [
        { runtime: "claude", rank: 1 },
        { runtime: "codex", rank: 1 },
      ],
    });
    // Tie, equal pre-ratings: expected=0.5, score=0.5 → delta=0.
    const claudeResult = game.results.find((r) => r.runtime === "claude")!;
    const codexResult = game.results.find((r) => r.runtime === "codex")!;
    expect(claudeResult.delta).toBeCloseTo(0, 5);
    expect(codexResult.delta).toBeCloseTo(0, 5);
    // Multiple "winners" at bestRank → no single winner recorded.
    expect(game.winner_runtime).toBeNull();
  });

  it("persists ratings across recordGame calls", () => {
    elo.recordGame({
      game_id: "g1",
      mission_id: "m1",
      grip_id: "grip1",
      results: [
        { runtime: "claude", rank: 1 },
        { runtime: "codex", rank: 2 },
      ],
    });
    const claude = elo.getRating("claude");
    expect(claude.rating).toBeCloseTo(1516, 5);
    expect(claude.games).toBe(1);
    expect(claude.wins).toBe(1);
    expect(claude.losses).toBe(0);
    const codex = elo.getRating("codex");
    expect(codex.rating).toBeCloseTo(1484, 5);
    expect(codex.losses).toBe(1);
  });

  it("throws when fewer than 2 participants", () => {
    expect(() =>
      elo.recordGame({
        game_id: "g1",
        mission_id: "m1",
        grip_id: "grip1",
        results: [{ runtime: "claude", rank: 1 }],
      }),
    ).toThrow(/at least 2/);
  });
});

describe("EloService.listRatings", () => {
  it("returns empty when no ratings recorded", () => {
    expect(elo.listRatings()).toEqual([]);
  });

  it("returns ratings sorted by rating descending", () => {
    elo.recordGame({
      game_id: "g1",
      mission_id: "m1",
      grip_id: "grip1",
      results: [
        { runtime: "claude", rank: 1 },
        { runtime: "codex", rank: 2 },
        { runtime: "gemini", rank: 3 },
      ],
    });
    const ratings = elo.listRatings();
    expect(ratings.map((r) => r.runtime_name)).toEqual(["claude", "codex", "gemini"]);
  });
});

describe("parseVerdictForElo", () => {
  it("returns null on garbage input", () => {
    expect(parseVerdictForElo("nonsense")).toBeNull();
    expect(parseVerdictForElo("")).toBeNull();
  });

  it("parses a ranking array", () => {
    const results = parseVerdictForElo('{"ranking": ["claude", "codex", "gemini"]}');
    expect(results).toEqual([
      { runtime: "claude", rank: 1 },
      { runtime: "codex", rank: 2 },
      { runtime: "gemini", rank: 3 },
    ]);
  });

  it("parses a final_scores map and ranks by score desc", () => {
    const results = parseVerdictForElo(
      '{"final_scores": {"claude": 95, "codex": 80, "gemini": 60}}',
    );
    expect(results).toEqual([
      { runtime: "claude", rank: 1 },
      { runtime: "codex", rank: 2 },
      { runtime: "gemini", rank: 3 },
    ]);
  });

  it("assigns the same rank to tied scores", () => {
    const results = parseVerdictForElo('{"final_scores": {"a": 90, "b": 90, "c": 70}}');
    // Both a and b have the same top score → both rank 1.
    expect(results).not.toBeNull();
    const byRuntime = Object.fromEntries(results!.map((r) => [r.runtime, r.rank]));
    expect(byRuntime.a).toBe(1);
    expect(byRuntime.b).toBe(1);
    expect(byRuntime.c).toBe(3);
  });

  it("tolerates prose and code fences wrapping the JSON", () => {
    const text = [
      "Here is my analysis:",
      "",
      "```json",
      '{ "ranking": ["claude", "codex"], "reasoning": "claude was more thorough" }',
      "```",
      "",
      "Final verdict above.",
    ].join("\n");
    const results = parseVerdictForElo(text);
    expect(results).toEqual([
      { runtime: "claude", rank: 1 },
      { runtime: "codex", rank: 2 },
    ]);
  });

  it("returns null when ranking has only one entry", () => {
    expect(parseVerdictForElo('{"ranking": ["claude"]}')).toBeNull();
  });
});
