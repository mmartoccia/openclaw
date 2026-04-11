// Octopus Orchestrator — RemotePtyTmuxAdapter
//
// Spawns arms on remote nodes via SSH + tmux. Same tmux lifecycle as
// the local PtyTmuxAdapter (sentinel files, ProcessWatcher) but the
// tmux session runs on a remote machine.
//
// The remote node must have:
//   - SSH access (key-based or sshpass)
//   - tmux installed
//   - The target CLI tools (claude, codex, gemini) installed
//   - A writable sentinel directory (/tmp/octo-sentinels/)
//
// The local ProcessWatcher cannot monitor remote tmux sessions, so
// this adapter polls the remote sentinel file via SSH to detect
// completion. Exit code and output are pulled back via SSH/scp.
//
// Boundary discipline (OCTO-DEC-033):
//   Only `node:*` builtins and relative paths inside `src/octo/`.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ArmSpec } from "../wire/schema.ts";
import { AdapterError, type Adapter, type SessionRef, type AdapterEvent } from "./base.ts";

const execFileAsync = promisify(execFile);

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface RemoteNodeConfig {
  host: string;
  user: string;
  /** SSH password (if not using key auth). Prefer keys in production. */
  password?: string;
  /** Path to SSH private key. */
  keyPath?: string;
  /** Remote sentinel directory. Defaults to /tmp/octo-sentinels. */
  sentinelDir?: string;
  /** Poll interval for remote sentinel check (ms). Defaults to 2000. */
  pollIntervalMs?: number;
}

export interface RemotePtyTmuxAdapterOptions {
  remoteNodes: Map<string, RemoteNodeConfig>;
  localSentinelDir?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function armSessionName(armId: string): string {
  return `octo-arm-${armId}`;
}

function shellQuote(s: string): string {
  return /^[a-zA-Z0-9_./:=@-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

async function sshExec(
  node: RemoteNodeConfig,
  command: string,
  timeoutMs = 30000,
): Promise<{ stdout: string; stderr: string }> {
  const args: string[] = ["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10"];
  if (node.keyPath) {
    args.push("-i", node.keyPath);
  }
  args.push(`${node.user}@${node.host}`, command);

  // If password auth, use sshpass
  let cmd: string;
  let cmdArgs: string[];
  if (node.password) {
    cmd = "sshpass";
    cmdArgs = ["-p", node.password, "ssh", ...args];
  } else {
    cmd = "ssh";
    cmdArgs = args;
  }

  const result = await execFileAsync(cmd, cmdArgs, { timeout: timeoutMs });
  return { stdout: result.stdout, stderr: result.stderr };
}

// ──────────────────────────────────────────────────────────────────────────
// RemotePtyTmuxAdapter
// ──────────────────────────────────────────────────────────────────────────

export class RemotePtyTmuxAdapter implements Adapter {
  readonly type = "pty_tmux" as const;

  private readonly remoteNodes: Map<string, RemoteNodeConfig>;
  private readonly localSentinelDir: string;
  private readonly activePollers = new Map<string, NodeJS.Timeout>();
  private readonly completionCallbacks = new Map<string, (exitCode: number | null) => void>();

  constructor(opts: RemotePtyTmuxAdapterOptions) {
    this.remoteNodes = opts.remoteNodes;
    this.localSentinelDir =
      opts.localSentinelDir ?? join(process.env.TMPDIR ?? "/tmp", "octo-sentinels");
    mkdirSync(this.localSentinelDir, { recursive: true });
  }

  async spawn(spec: ArmSpec): Promise<SessionRef> {
    // Determine target node from spec labels or env
    const targetNodeId = spec.labels?.target_node ?? spec.env?.OCTO_TARGET_NODE;
    if (!targetNodeId) {
      throw new AdapterError(
        "invalid_spec",
        "remote_pty_tmux: spec.labels.target_node or env.OCTO_TARGET_NODE required",
      );
    }

    const node = this.remoteNodes.get(targetNodeId);
    if (!node) {
      throw new AdapterError(
        "not_found",
        `remote_pty_tmux: unknown node "${targetNodeId}". Known: ${[...this.remoteNodes.keys()].join(", ")}`,
      );
    }

    const armId = (spec as Record<string, unknown>)._arm_id as string | undefined;
    const sessionName = armSessionName(armId ?? spec.idempotency_key);
    const remoteSentinelDir = node.sentinelDir ?? "/tmp/octo-sentinels";
    const remoteSentinelPath = `${remoteSentinelDir}/${armId}.exit`;
    const remoteOutputPath = `${remoteSentinelDir}/${armId}.output`;

    // Build the command string
    const rtOpts = spec.runtime_options as { command: string; args?: string[] };
    const cmdParts = [rtOpts.command, ...(rtOpts.args ?? []).map(shellQuote)];
    const userCmd = cmdParts.join(" ");

    // Wrap with sentinel + output capture
    const wrappedCmd = `${userCmd} 2>&1 | tee ${remoteOutputPath}; _ec=\\$\\{PIPESTATUS[0]:-\\$?\\}; echo \\$_ec > ${remoteSentinelPath}; exit \\$_ec`;

    // Create sentinel dir on remote
    await sshExec(node, `mkdir -p ${remoteSentinelDir}`);

    // Start tmux session on remote
    const tmuxCmd = `tmux new-session -d -s ${sessionName} -c ${shellQuote(spec.cwd)} '${wrappedCmd}'`;
    try {
      await sshExec(node, tmuxCmd);
    } catch (err) {
      throw new AdapterError(
        "spawn_failed",
        `remote_pty_tmux: tmux spawn failed on ${targetNodeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Start polling for sentinel file on remote
    const pollInterval = node.pollIntervalMs ?? 2000;
    const poller = setInterval(async () => {
      try {
        const result = await sshExec(
          node,
          `cat ${remoteSentinelPath} 2>/dev/null || echo "__PENDING__"`,
          10000,
        );
        const content = result.stdout.trim();
        if (content !== "__PENDING__" && /^-?\d+$/.test(content)) {
          const exitCode = parseInt(content, 10);
          clearInterval(poller);
          this.activePollers.delete(sessionName);

          // Pull output file to local
          try {
            const outputResult = await sshExec(node, `cat ${remoteOutputPath} 2>/dev/null`, 15000);
            const localOutputPath = join(this.localSentinelDir, `${armId}.output`);
            writeFileSync(localOutputPath, outputResult.stdout);
          } catch {
            // Best effort output pull
          }

          // Write local sentinel so ProcessWatcher can detect completion
          const localSentinelPath = join(this.localSentinelDir, `${armId}.exit`);
          writeFileSync(localSentinelPath, String(exitCode));

          // Fire completion callback
          const cb = this.completionCallbacks.get(sessionName);
          if (cb) {
            this.completionCallbacks.delete(sessionName);
            cb(exitCode);
          }
        }
      } catch {
        // SSH poll failed — retry next interval
      }
    }, pollInterval);

    this.activePollers.set(sessionName, poller);

    return {
      adapter_type: this.type,
      session_id: sessionName,
      cwd: spec.cwd,
      attach_command: `ssh ${node.user}@${node.host} -t 'tmux attach -t ${sessionName}'`,
      metadata: {
        remote_node: targetNodeId,
        remote_host: node.host,
        tmux_session_name: sessionName,
      },
    };
  }

  async health(ref: SessionRef): Promise<"alive" | "dead" | "unknown"> {
    const localSentinel = join(
      this.localSentinelDir,
      `${ref.session_id.replace("octo-arm-", "")}.exit`,
    );
    if (existsSync(localSentinel)) {
      return "dead";
    }
    if (this.activePollers.has(ref.session_id)) {
      return "alive";
    }
    return "unknown";
  }

  async terminate(ref: SessionRef): Promise<boolean> {
    const meta = ref.metadata as Record<string, string> | undefined;
    const nodeId = meta?.remote_node;
    if (!nodeId) {
      return false;
    }
    const node = this.remoteNodes.get(nodeId);
    if (!node) {
      return false;
    }

    try {
      await sshExec(node, `tmux kill-session -t ${ref.session_id} 2>/dev/null`);
      const poller = this.activePollers.get(ref.session_id);
      if (poller) {
        clearInterval(poller);
        this.activePollers.delete(ref.session_id);
      }
      return true;
    } catch {
      return false;
    }
  }

  onExit(sessionId: string, callback: (exitCode: number | null) => void): void {
    // Check if already completed
    const localSentinel = join(this.localSentinelDir, `${sessionId.replace("octo-arm-", "")}.exit`);
    if (existsSync(localSentinel)) {
      const content = readFileSync(localSentinel, "utf8").trim();
      callback(/^-?\d+$/.test(content) ? parseInt(content, 10) : null);
      return;
    }
    this.completionCallbacks.set(sessionId, callback);
  }

  // Stub implementations for Adapter interface
  async resume(ref: SessionRef): Promise<SessionRef> {
    return ref;
  }
  async send(_ref: SessionRef, _input: string): Promise<void> {}
  async checkpoint(_ref: SessionRef): Promise<Record<string, unknown>> {
    return {};
  }
  async *stream(_ref: SessionRef, _signal?: AbortSignal): AsyncGenerator<AdapterEvent> {}
}
