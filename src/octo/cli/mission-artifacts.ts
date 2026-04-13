// Octopus Orchestrator — `openclaw octo mission artifacts <id>` CLI
//
// Operator-DX feature added 2026-04-12 from openclaw-main's batch 3 friction
// log. Operators previously had to grep `~/.openclaw/octo/artifacts/<dir>/`
// by hand to find canonical mission outputs. This command walks the mission's
// artifact tree and prints, per grip:
//   - canonical .octo stdout file (size, path)
//   - real touched files (size, path) — i.e. anything other than .octo,
//     _inputs, or sentinels
//
// It does not promote, copy, or modify anything. It is a pure read view
// over the on-disk artifact tree owned by the NodeAgent's promotion step.
//
// Boundary discipline (OCTO-DEC-033): node:* and relative imports only.

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RegistryService } from "../head/registry.ts";
import type { MissionJsonOption, WritableOutput } from "./mission.ts";

export interface MissionArtifactsOptions extends MissionJsonOption {
  missionId: string;
}

interface FileEntry {
  path: string;
  bytes: number;
}

interface GripArtifactGroup {
  grip_id: string;
  round?: string;
  runtime?: string;
  stdout_file: FileEntry | null;
  real_files: FileEntry[];
  inputs_files: FileEntry[];
}

export interface MissionArtifactsResult {
  mission_id: string;
  artifact_root: string;
  groups: GripArtifactGroup[];
  not_found: boolean;
}

const defaultOut: WritableOutput = process.stdout;

function listFiles(dir: string): FileEntry[] {
  const out: FileEntry[] = [];
  if (!existsSync(dir)) {
    return out;
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) {
      continue;
    }
    const full = join(dir, e.name);
    try {
      out.push({ path: full, bytes: statSync(full).size });
    } catch {
      // skip
    }
  }
  return out;
}

/**
 * Parse a grip directory name like
 * `mis-XXX_pipeline-state-machine_round-2_codex` into its parts.
 *
 * Format: `<mission_id>_<grip>_round-<n>_<runtime>` for collaborative
 * chains, or `<mission_id>_<grip>` for plain direct-execute grips.
 *
 * The grip name itself may contain underscores (it's not safe to
 * naively split), so we strip the mission id prefix and then take the
 * trailing `_round-<n>_<runtime>` suffix if present.
 */
function parseGripDir(
  missionId: string,
  dirName: string,
): {
  grip: string;
  round?: string;
  runtime?: string;
} | null {
  const prefix = `${missionId}_`;
  if (!dirName.startsWith(prefix)) {
    return null;
  }
  const rest = dirName.slice(prefix.length);
  // Match trailing _round-<n>_<runtime>
  const m = /^(.+)_round-(\d+)_([a-zA-Z0-9-]+)$/.exec(rest);
  if (m) {
    return { grip: m[1], round: `round-${m[2]}`, runtime: m[3] };
  }
  return { grip: rest };
}

/**
 * Walk the mission artifact tree and group files by grip.
 *
 * The artifact tree layout (NodeAgent's promotion convention):
 *   <root>/<mission_id>/
 *     <mission_id>_<grip>_round-<n>_<runtime>/
 *       arm-<id>.stdout.txt        ← raw stdout dump
 *       <touched files...>         ← files the runtime wrote in cwd
 *
 * The .octo stdout file lives inside cwd at .octo/<arm-id>.stdout.md
 * and gets copied into the artifact tree alongside touched files.
 * `_inputs/<dep>.md` files are dependency-handoff scratch and are
 * shown in their own group, not as deliverables.
 */
export function gatherMissionArtifacts(
  registry: RegistryService,
  opts: MissionArtifactsOptions,
): MissionArtifactsResult {
  const mission = registry.getMission(opts.missionId);
  if (mission === null) {
    return {
      mission_id: opts.missionId,
      artifact_root: "",
      groups: [],
      not_found: true,
    };
  }
  const artifactRoot = join(homedir(), ".openclaw", "octo", "artifacts", opts.missionId);
  const groups: GripArtifactGroup[] = [];
  if (!existsSync(artifactRoot)) {
    return {
      mission_id: opts.missionId,
      artifact_root: artifactRoot,
      groups: [],
      not_found: false,
    };
  }
  const dirs = readdirSync(artifactRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  for (const dirName of dirs) {
    const parsed = parseGripDir(opts.missionId, dirName);
    if (!parsed) {
      continue;
    }
    const dirPath = join(artifactRoot, dirName);
    const allFiles = listFiles(dirPath);
    let stdout: FileEntry | null = null;
    const real: FileEntry[] = [];
    const inputs: FileEntry[] = [];
    for (const f of allFiles) {
      const base = f.path.slice(dirPath.length + 1);
      // Raw stdout dump from the wrapper sentinel — operator usually
      // wants the .octo/<arm>.stdout.md companion, not this.
      if (base.startsWith("arm-") && base.endsWith(".stdout.txt")) {
        // Treat the per-arm raw stdout as the stdout slot if no .octo
        // companion was promoted alongside.
        if (!stdout) {
          stdout = f;
        }
        continue;
      }
      if (base.startsWith("arm-") && base.endsWith(".stdout.md")) {
        stdout = f;
        continue;
      }
      if (base === "_inputs" || base.startsWith("_inputs/")) {
        inputs.push(f);
        continue;
      }
      if (base === ".octo" || base.startsWith(".octo/")) {
        // Already handled above
        continue;
      }
      real.push(f);
    }
    groups.push({
      grip_id: parsed.grip,
      round: parsed.round,
      runtime: parsed.runtime,
      stdout_file: stdout,
      real_files: real,
      inputs_files: inputs,
    });
  }
  // Stable sort: grip then round
  groups.sort((a, b) => {
    if (a.grip_id !== b.grip_id) {
      return a.grip_id.localeCompare(b.grip_id);
    }
    return (a.round ?? "").localeCompare(b.round ?? "");
  });
  return {
    mission_id: opts.missionId,
    artifact_root: artifactRoot,
    groups,
    not_found: false,
  };
}

function fmtBytes(n: number): string {
  if (n < 1024) {
    return `${n}B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)}KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatMissionArtifacts(result: MissionArtifactsResult): string {
  const lines: string[] = [];
  if (result.not_found) {
    lines.push(`Mission not found: ${result.mission_id}`);
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`Mission: ${result.mission_id}`);
  lines.push(`Artifact root: ${result.artifact_root}`);
  if (result.groups.length === 0) {
    lines.push("");
    lines.push("(no artifact directories found — mission may not have completed)");
    lines.push("");
    return lines.join("\n");
  }
  for (const g of result.groups) {
    lines.push("");
    const header = g.round ? `Grip: ${g.grip_id}  [${g.round}/${g.runtime}]` : `Grip: ${g.grip_id}`;
    lines.push(header);
    if (g.stdout_file) {
      lines.push(`  stdout:  ${fmtBytes(g.stdout_file.bytes).padStart(8)}  ${g.stdout_file.path}`);
    } else {
      lines.push(`  stdout:  (none)`);
    }
    if (g.real_files.length > 0) {
      lines.push(`  files:`);
      for (const f of g.real_files) {
        lines.push(`           ${fmtBytes(f.bytes).padStart(8)}  ${f.path}`);
      }
    } else {
      lines.push(`  files:   (none — runtime did not write touched files)`);
    }
    if (g.inputs_files.length > 0) {
      lines.push(`  inputs:  ${g.inputs_files.length} dependency-handoff file(s)`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function formatMissionArtifactsJson(result: MissionArtifactsResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}

export function runMissionArtifacts(
  registry: RegistryService,
  opts: MissionArtifactsOptions,
  out: WritableOutput = defaultOut,
): number {
  const result = gatherMissionArtifacts(registry, opts);
  const output = opts.json ? formatMissionArtifactsJson(result) : formatMissionArtifacts(result);
  out.write(output);
  return result.not_found ? 1 : 0;
}
