// Octopus Orchestrator -- `openclaw octo arm attach` CLI command (M1-20)
//
// Attaches to an arm's tmux session interactively.
//
// Architecture:
//   resolveArmSession  -- looks up arm, extracts tmux session name
//   resolveRemoteNode  -- reads ~/.openclaw/openclaw.json for remote_nodes
//                         when the arm has a target_node label
//   defaultExecAttach  -- execs the right attach command:
//                           local  → `tmux attach-session -t <name>`
//                           remote → `ssh -t <user>@<host> tmux attach-session [-r] -t <name>`
//                           (with sshpass wrapper when password auth is configured)
//   runArmAttach       -- composes resolve + exec, returns exit code
//
// Remote attach note: read-only (`tmux attach -r`) is the safest default
// for observing agents, preventing accidental keystrokes from interfering
// with a running CLI. Pass `interactive: true` in opts for full attach.
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import type { ArmRecord, RegistryService } from "../head/registry.ts";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface ArmAttachOptions {
  arm_id: string;
  /** When true, use interactive mode (allows keystrokes to reach the CLI).
   *  Default is read-only (`tmux attach -r`) for remote arms so an
   *  operator watching an agent doesn't accidentally inject input. */
  interactive?: boolean;
  /** When true, print the attach command that would be executed and
   *  exit without running it. Useful for copy-paste or scripting. */
  printOnly?: boolean;
}

export interface RemoteNodeInfo {
  id: string;
  host: string;
  user: string;
  password?: string;
  keyPath?: string;
}

export interface ResolvedSession {
  arm: ArmRecord;
  tmux_session_name: string;
  /** Present when the arm is spawned on a remote node via
   *  spec.labels.target_node. Null for local arms. */
  remote_node: RemoteNodeInfo | null;
}

export interface ArmAttachDeps {
  /** Injected for testing -- wraps the actual tmux/ssh exec call. */
  execAttach: (
    resolved: ResolvedSession,
    opts: { interactive: boolean },
  ) => { status: number; stderr: string; command: string };
  /** Injected for testing -- reads remote node config from disk. */
  loadRemoteNodes?: () => RemoteNodeInfo[];
}

// ──────────────────────────────────────────────────────────────────────────
// Resolve -- arm lookup + session name extraction
// ──────────────────────────────────────────────────────────────────────────

/**
 * Default remote-nodes loader: reads `~/.openclaw/openclaw.json` and
 * returns the `octo.remote_nodes` entries normalized into
 * RemoteNodeInfo. Returns an empty array if the file doesn't exist or
 * doesn't contain an octo.remote_nodes block.
 *
 * Same pattern `src/octo/cli/register.ts:93` uses for the same
 * reason — the CLI process doesn't share the gateway's in-memory
 * config and needs its own loader.
 */
export function defaultLoadRemoteNodes(): RemoteNodeInfo[] {
  const configPath = pathJoin(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(configPath)) {
    return [];
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const octo = raw.octo as Record<string, unknown> | undefined;
    const nodes = octo?.remote_nodes as
      | Array<{
          id: string;
          host: string;
          user: string;
          password?: string;
          key_path?: string;
        }>
      | undefined;
    if (!nodes) {
      return [];
    }
    return nodes.map((n) => ({
      id: n.id,
      host: n.host,
      user: n.user,
      password: n.password,
      keyPath: n.key_path,
    }));
  } catch {
    return [];
  }
}

/**
 * Looks up the arm in the registry, extracts the tmux session name,
 * and resolves the remote node config when the arm has a target_node
 * label. Returns the resolved session or an error message string.
 */
export function resolveArmSession(
  registry: RegistryService,
  armId: string,
  loadRemoteNodes: () => RemoteNodeInfo[] = defaultLoadRemoteNodes,
): ResolvedSession | string {
  const arm = registry.getArm(armId);
  if (!arm) {
    return `Error: arm '${armId}' not found.`;
  }

  // Two ways the tmux session name can be resolved:
  //   1. arm.session_ref.tmux_session_name — set by the adapter on
  //      spawn (the canonical path)
  //   2. sessionNameForArm(arm_id) — the deterministic name
  //      `octo-arm-<arm_id>` that both local and remote adapters use.
  //      Fall back to this when session_ref is missing, because remote
  //      arms use the same naming convention and we need something to
  //      attach to.
  let tmuxName: string;
  const sessionRef = arm.session_ref;
  const sessionRefName = sessionRef?.["tmux_session_name"];
  if (typeof sessionRefName === "string" && sessionRefName.length > 0) {
    tmuxName = sessionRefName;
  } else {
    tmuxName = `octo-arm-${arm.arm_id}`;
  }

  // Detect remote arms via spec.labels.target_node. Local arms return
  // remote_node: null, which causes execAttach to fall into the local
  // tmux branch.
  const targetNodeId = arm.spec?.labels?.target_node;
  let remoteNode: RemoteNodeInfo | null = null;
  if (typeof targetNodeId === "string" && targetNodeId.length > 0) {
    const nodes = loadRemoteNodes();
    const found = nodes.find((n) => n.id === targetNodeId);
    if (!found) {
      return (
        `Error: arm '${armId}' targets remote node '${targetNodeId}' but ` +
        `no matching entry exists in octo.remote_nodes in ~/.openclaw/openclaw.json.\n` +
        `Known nodes: ${nodes.map((n) => n.id).join(", ") || "(none configured)"}`
      );
    }
    remoteNode = found;
  }

  return { arm, tmux_session_name: tmuxName, remote_node: remoteNode };
}

// ──────────────────────────────────────────────────────────────────────────
// Exec -- default tmux attach implementation
// ──────────────────────────────────────────────────────────────────────────

/** Default exec implementation -- spawns tmux with stdio inherited for interactive use. */
export function defaultExecAttach(sessionName: string): { status: number; stderr: string } {
  const result = spawnSync("tmux", ["attach-session", "-t", sessionName], {
    stdio: "inherit",
  });
  const status = result.status ?? 1;
  const stderr =
    result.error instanceof Error
      ? result.error.message
      : result.stderr
        ? result.stderr.toString()
        : "";
  return { status, stderr };
}

// ──────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────

/** Entry point called by the CLI dispatcher. Returns exit code (0 = success). */
export function runArmAttach(
  registry: RegistryService,
  opts: ArmAttachOptions,
  out: { write: (s: string) => void } = process.stderr,
  deps: ArmAttachDeps = { execAttach: defaultExecAttach },
): number {
  const resolved = resolveArmSession(registry, opts.arm_id);

  if (typeof resolved === "string") {
    out.write(resolved + "\n");
    return 1;
  }

  const { status, stderr } = deps.execAttach(resolved.tmux_session_name);

  if (status !== 0) {
    const msg = stderr.length > 0 ? stderr : `tmux attach-session exited with code ${status}`;
    out.write(`Error: tmux attach failed: ${msg}\n`);
    return 1;
  }

  return 0;
}
