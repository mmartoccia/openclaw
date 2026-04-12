// Octopus Orchestrator — Elo rating service
//
// Records competitive mission outcomes and maintains a per-runtime Elo
// rating. Persisted to the SQLite registry via the `elo_ratings` and
// `elo_games` tables (see head/storage/schema.sql).
//
// Pairwise Elo with K=32: for a game with N ranked contestants we iterate
// every (i, j) pair where i < j (by rank), treat the better-ranked as the
// winner and the worse-ranked as the loser, and apply a standard Elo
// update to each participant. Ties (same rank) score 0.5/0.5.
//
// Why pairwise: it degenerates cleanly to the standard 2-player Elo for
// 1v1 rounds and produces sensible deltas for 3+ contestants without
// needing a multi-player extension. K=32 is the classic chess default —
// reasonable starting point, tunable later if ratings turn out too volatile.

import type { DatabaseSync } from "node:sqlite";

const DEFAULT_RATING = 1500;
const K_FACTOR = 32;

export interface RatingRow {
  runtime_name: string;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  ties: number;
  last_updated: number;
}

export interface GameResult {
  /** Runtime name (e.g., "claude", "codex", "gemini"). */
  runtime: string;
  /** 1-based rank. Ties share the same rank number. */
  rank: number;
}

export interface RecordedGame {
  game_id: string;
  mission_id: string;
  grip_id: string;
  winner_runtime: string | null;
  /** Per-runtime pre/post rating snapshot. */
  results: Array<{
    runtime: string;
    rank: number;
    rating_before: number;
    rating_after: number;
    delta: number;
  }>;
}

function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

export class EloService {
  constructor(private readonly db: DatabaseSync) {}

  /** Get or create the rating row for a runtime. */
  getRating(runtimeName: string): RatingRow {
    const row = this.db
      .prepare("SELECT * FROM elo_ratings WHERE runtime_name = ?")
      .get(runtimeName) as unknown as RatingRow | undefined;
    if (row) {
      return row;
    }
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO elo_ratings (runtime_name, rating, games, wins, losses, ties, last_updated) " +
          "VALUES (?, ?, 0, 0, 0, 0, ?)",
      )
      .run(runtimeName, DEFAULT_RATING, now);
    return {
      runtime_name: runtimeName,
      rating: DEFAULT_RATING,
      games: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      last_updated: now,
    };
  }

  /** List all rating rows, sorted by rating descending. */
  listRatings(): RatingRow[] {
    return this.db
      .prepare("SELECT * FROM elo_ratings ORDER BY rating DESC")
      .all() as unknown as RatingRow[];
  }

  /**
   * Record a game outcome and update ratings.
   *
   * `results` must contain at least 2 participants with 1-based ranks.
   * Returns the recorded game row including pre/post ratings so callers
   * can log or display the deltas.
   */
  recordGame(params: {
    game_id: string;
    mission_id: string;
    grip_id: string;
    results: GameResult[];
  }): RecordedGame {
    const { game_id, mission_id, grip_id, results } = params;
    if (results.length < 2) {
      throw new Error("EloService.recordGame: need at least 2 participants");
    }

    // Snapshot pre-ratings (and seed rows for any new runtime).
    const pre = new Map<string, number>();
    for (const r of results) {
      pre.set(r.runtime, this.getRating(r.runtime).rating);
    }

    // Pairwise updates. `delta[runtime]` accumulates rating change.
    const delta = new Map<string, number>();
    for (const r of results) {
      delta.set(r.runtime, 0);
    }

    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const a = results[i];
        const b = results[j];
        const ra = pre.get(a.runtime)!;
        const rb = pre.get(b.runtime)!;
        const ea = expectedScore(ra, rb);
        const eb = 1 - ea;

        let sa: number;
        let sb: number;
        if (a.rank === b.rank) {
          sa = 0.5;
          sb = 0.5;
        } else if (a.rank < b.rank) {
          sa = 1;
          sb = 0;
        } else {
          sa = 0;
          sb = 1;
        }

        delta.set(a.runtime, delta.get(a.runtime)! + K_FACTOR * (sa - ea));
        delta.set(b.runtime, delta.get(b.runtime)! + K_FACTOR * (sb - eb));
      }
    }

    // Persist rating updates and collect per-participant snapshot.
    const now = Date.now();
    const snapshot: RecordedGame["results"] = [];
    const bestRank = Math.min(...results.map((r) => r.rank));
    const winners = results.filter((r) => r.rank === bestRank);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of results) {
        const ratingBefore = pre.get(r.runtime)!;
        const ratingAfter = ratingBefore + delta.get(r.runtime)!;
        const isWinner = r.rank === bestRank && winners.length === 1;
        const isLoser = r.rank !== bestRank;
        const isTie = r.rank === bestRank && winners.length > 1;

        this.db
          .prepare(
            "UPDATE elo_ratings SET rating = ?, games = games + 1, " +
              "wins = wins + ?, losses = losses + ?, ties = ties + ?, last_updated = ? " +
              "WHERE runtime_name = ?",
          )
          .run(ratingAfter, isWinner ? 1 : 0, isLoser ? 1 : 0, isTie ? 1 : 0, now, r.runtime);

        snapshot.push({
          runtime: r.runtime,
          rank: r.rank,
          rating_before: ratingBefore,
          rating_after: ratingAfter,
          delta: ratingAfter - ratingBefore,
        });
      }

      const winnerRuntime = winners.length === 1 ? winners[0].runtime : null;
      this.db
        .prepare(
          "INSERT INTO elo_games (game_id, mission_id, grip_id, winner_runtime, results_json, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(game_id, mission_id, grip_id, winnerRuntime, JSON.stringify(snapshot), now);

      this.db.exec("COMMIT");

      return {
        game_id,
        mission_id,
        grip_id,
        winner_runtime: winnerRuntime,
        results: snapshot,
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

/**
 * Parse a verdict JSON output string and extract the ranked list of
 * runtimes. Returns null if the format doesn't match.
 *
 * Accepted shapes:
 *   { "ranking": ["claude", "codex", "gemini"] }           // ordered list
 *   { "winner": "claude", "ranking": ["claude", ...] }
 *   { "final_scores": { "claude": 95, "codex": 87 } }      // derive rank by score
 */
export function parseVerdictForElo(verdictText: string): GameResult[] | null {
  // Try to locate a JSON object within the verdict text. LLM output is
  // often wrapped in prose or code fences.
  const fenceMatch = verdictText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const jsonStart = verdictText.indexOf("{");
  const jsonCandidate = fenceMatch
    ? fenceMatch[1]
    : jsonStart >= 0
      ? verdictText.slice(jsonStart)
      : null;
  if (!jsonCandidate) {
    return null;
  }

  let parsed: unknown;
  try {
    // Attempt full parse first; fall back to brace-balanced slice.
    parsed = JSON.parse(jsonCandidate);
  } catch {
    // Best-effort: trim to first balanced { ... } block.
    let depth = 0;
    let end = -1;
    for (let i = 0; i < jsonCandidate.length; i++) {
      if (jsonCandidate[i] === "{") {
        depth++;
      } else if (jsonCandidate[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) {
      return null;
    }
    try {
      parsed = JSON.parse(jsonCandidate.slice(0, end));
    } catch {
      return null;
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;

  // Case 1: explicit ranking array.
  if (Array.isArray(obj.ranking)) {
    const ranking = obj.ranking.filter((x): x is string => typeof x === "string");
    if (ranking.length >= 2) {
      return ranking.map((runtime, i) => ({ runtime, rank: i + 1 }));
    }
  }

  // Case 2: final_scores map — derive rank by descending score.
  if (typeof obj.final_scores === "object" && obj.final_scores !== null) {
    const scores = Object.entries(obj.final_scores as Record<string, unknown>)
      .filter((e): e is [string, number] => typeof e[1] === "number")
      .toSorted((a, b) => b[1] - a[1]);
    if (scores.length >= 2) {
      let rank = 1;
      const out: GameResult[] = [];
      for (let i = 0; i < scores.length; i++) {
        if (i > 0 && scores[i][1] < scores[i - 1][1]) {
          rank = i + 1;
        }
        out.push({ runtime: scores[i][0], rank });
      }
      return out;
    }
  }

  return null;
}
