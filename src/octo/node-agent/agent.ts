// Octopus Orchestrator — Node Agent runtime loop (M2-03)
//
// References:
//   - LLD.md §"Node Agent Internals" (line ~522) — module composition
//   - LLD.md §"SessionReconciler behavior" (line ~533) — startup reconciliation
//   - DECISIONS.md OCTO-DEC-033 — boundary discipline (node:* builtins +
//     relative imports inside src/octo/ only)
//
// The Node Agent is a long-running process on a single machine that:
//   1. On startup: runs SessionReconciler to match live tmux sessions
//      against persisted arm rows. Recovered arms get ProcessWatcher.watch()
//      so their exits are detected.
//   2. Liveness polling loop: every N ms, for each arm in `starting` state
//      on this node, checks if the tmux session exists (batch once per tick)
//      and drives `starting -> active` or `starting -> failed` FSM transitions.
//   3. ProcessWatcher event handling: when ProcessWatcher emits a `failed`
//      or `completed` event for a watched arm, drives the FSM transition.
//   4. Clean shutdown: stop() clears the polling interval, stops
//      ProcessWatcher. Does NOT terminate tmux sessions.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyArmTransition, InvalidTransitionError } from "../head/arm-fsm.ts";
import { classifyFailure } from "../head/classify-failure.ts";
import { parseVerdictForElo, type EloService } from "../head/elo.ts";
import type { EventLogService } from "../head/event-log.ts";
import type { AppendInput } from "../head/event-log.ts";
import { applyGripTransition } from "../head/grip-fsm.ts";
import { applyMissionTransition } from "../head/mission-fsm.ts";
import { ConflictError } from "../head/registry.ts";
import type { ArmRecord, RegistryService } from "../head/registry.ts";
import { ProcessWatcher, type ProcessWatcherEvent } from "./process-watcher.ts";
import { SessionReconciler, type ReconciliationReport } from "./session-reconciler.ts";
import { TmuxManager } from "./tmux-manager.ts";

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

export interface RemoteNodeConfig {
  host: string;
  user: string;
  password?: string;
  keyPath?: string;
  sentinelDir?: string;
}

export interface NodeAgentOptions {
  nodeId: string;
  registry: RegistryService;
  eventLog: EventLogService;
  tmuxManager?: TmuxManager;
  pollIntervalMs?: number;
  processWatcherPollMs?: number;
  sessionNamePrefix?: string;
  /** Directory for sentinel files. Defaults to <os.tmpdir()>/octo-sentinels. */
  sentinelDir?: string;
  now?: () => number;
  /** Remote node configs for distributed arm polling. */
  remoteNodes?: Map<string, RemoteNodeConfig>;
  /** Optional Elo service: when present, competitive mission verdicts
   *  are parsed on mission completion and ratings are updated. */
  elo?: EloService;
  logger?: (entry: {
    level: "info" | "warn" | "error";
    message: string;
    details?: Record<string, unknown>;
  }) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_PROCESS_WATCHER_POLL_MS = 250;
const DEFAULT_SESSION_NAME_PREFIX = "octo-arm-";

// ──────────────────────────────────────────────────────────────────────────
// NodeAgent
// ──────────────────────────────────────────────────────────────────────────

export class NodeAgent {
  private readonly nodeId: string;
  private readonly registry: RegistryService;
  private readonly eventLog: EventLogService;
  private readonly tmuxManager: TmuxManager;
  private readonly pollIntervalMs: number;
  private readonly sessionNamePrefix: string;
  private readonly sentinelDir: string;
  private readonly nowFn: () => number;
  private readonly processWatcher: ProcessWatcher;
  private readonly reconciler: SessionReconciler;
  private readonly logger: NodeAgentOptions["logger"];

  private readonly remoteNodes: Map<string, RemoteNodeConfig>;
  private readonly elo: EloService | undefined;

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private pollInFlight = false;

  constructor(opts: NodeAgentOptions) {
    if (typeof opts.nodeId !== "string" || opts.nodeId.length === 0) {
      throw new Error("NodeAgent: nodeId must be a non-empty string");
    }
    this.nodeId = opts.nodeId;
    this.registry = opts.registry;
    this.eventLog = opts.eventLog;
    this.tmuxManager = opts.tmuxManager ?? new TmuxManager();
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sessionNamePrefix = opts.sessionNamePrefix ?? DEFAULT_SESSION_NAME_PREFIX;
    this.sentinelDir =
      opts.sentinelDir ??
      path.join(
        // Use a temp-dir-based default for isolation
        process.env.TMPDIR ?? "/tmp",
        "octo-sentinels",
      );
    this.nowFn = opts.now ?? (() => Date.now());
    this.remoteNodes = opts.remoteNodes ?? new Map();
    this.elo = opts.elo;
    this.logger = opts.logger;

    this.processWatcher = new ProcessWatcher({
      pollIntervalMs: opts.processWatcherPollMs ?? DEFAULT_PROCESS_WATCHER_POLL_MS,
      tmuxManager: this.tmuxManager,
    });

    this.reconciler = new SessionReconciler(this.tmuxManager, this.registry, {
      nodeId: this.nodeId,
      sessionNamePrefix: this.sessionNamePrefix,
      now: this.nowFn,
      logger: this.logger,
    });

    // Wire up ProcessWatcher events.
    this.processWatcher.on("process", (event: ProcessWatcherEvent) => {
      void this.handleProcessEvent(event);
    });
  }

  /**
   * Start the agent: reconcile, attach watchers for active/starting arms,
   * begin the liveness polling loop.
   */
  async start(): Promise<ReconciliationReport> {
    if (this.running) {
      throw new Error("NodeAgent: already running");
    }

    // Ensure sentinel directory exists.
    mkdirSync(this.sentinelDir, { recursive: true });

    // Reconcile on startup.
    const report = await this.reconciler.reconcile();

    // Watch all starting/active arms for this node. Skip remote arms
    // (target_node label set) — those have no local tmux session, and
    // ProcessWatcher would fail them with `session_terminated_no_sentinel`
    // on the first tick. Remote liveness is handled by pollTick step 4.
    const arms = this.registry.listArms({ node_id: this.nodeId });
    for (const arm of arms) {
      if (arm.spec?.labels?.target_node) {
        continue;
      }
      if (arm.state === "starting" || arm.state === "active") {
        this.watchArm(arm);
      }
    }

    // Start the polling loop.
    this.running = true;
    this.pollHandle = setInterval(() => {
      void this.pollTick();
    }, this.pollIntervalMs);

    return report;
  }

  /** Stop the agent cleanly. Does NOT terminate tmux sessions. */
  stop(): void {
    this.running = false;
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.processWatcher.stop();
  }

  /** Is the agent currently running? */
  isRunning(): boolean {
    return this.running;
  }

  /** Force a reconciliation pass (also runs on start). */
  async reconcile(): Promise<ReconciliationReport> {
    const report = await this.reconciler.reconcile();

    // Watch any newly-discovered starting/active arms. Same remote skip
    // rule as start(): remote arms are handled by pollTick step 4.
    const arms = this.registry.listArms({ node_id: this.nodeId });
    for (const arm of arms) {
      if (arm.spec?.labels?.target_node) {
        continue;
      }
      if (arm.state === "starting" || arm.state === "active") {
        this.watchArm(arm);
      }
    }

    return report;
  }

  /** Compute the sentinel path for an arm. */
  sentinelPathForArm(arm_id: string): string {
    return path.join(this.sentinelDir, `${arm_id}.exit`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private: polling
  // ────────────────────────────────────────────────────────────────────────

  private async pollTick(): Promise<void> {
    if (this.pollInFlight || !this.running) {
      return;
    }
    this.pollInFlight = true;
    try {
      // 1. Fetch all starting arms for this node.
      const startingArms = this.registry.listArms({
        node_id: this.nodeId,
        state: "starting",
      });

      if (startingArms.length === 0) {
        return;
      }

      // 2. Batch-fetch live tmux sessions once per tick.
      let liveNames: Set<string>;
      try {
        const names = await this.tmuxManager.listSessions();
        liveNames = new Set(names);
      } catch (err) {
        this.log("error", "pollTick: tmux listSessions failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return; // Skip this tick; do not crash.
      }

      // 3. For each starting arm, check liveness.
      for (const arm of startingArms) {
        // Only poll LOCAL tmux sessions for pty_tmux arms. Skip remote arms
        // (they're handled in step 4) and non-pty_tmux adapters.
        if (arm.adapter_type !== "pty_tmux") {
          continue;
        }
        // Remote arms have target_node in spec labels — skip local check.
        if (arm.spec?.labels?.target_node) {
          continue;
        }

        const sessionName = `${this.sessionNamePrefix}${arm.arm_id}`;

        if (liveNames.has(sessionName)) {
          // Session is alive -- transition to active.
          await this.transitionArm(arm, "active", "arm.active");
          // Start watching for exit.
          this.watchArm(arm);
        } else {
          // Session not found. Before declaring failure, check the
          // sentinel file — the command may have exited cleanly before
          // this poll tick ran. Fast-exiting commands (echo, simple
          // scripts) commonly hit this race: the tmux session is gone
          // but the sentinel file has the exit code.
          const sentinelPath = path.join(this.sentinelDir, `${arm.arm_id}.exit`);
          let exitCode: number | null = null;
          if (existsSync(sentinelPath)) {
            try {
              const content = readFileSync(sentinelPath, "utf8").trim();
              if (/^-?\d+$/.test(content)) {
                exitCode = Number.parseInt(content, 10);
              }
            } catch {
              // Best-effort sentinel read.
            }
          }

          if (exitCode === 0) {
            // Clean exit — drive starting → active → completed.
            const activated = await this.transitionArm(arm, "active", "arm.active");
            if (activated) {
              const updatedArm = this.registry.getArm(arm.arm_id);
              if (updatedArm) {
                await this.transitionArm(updatedArm, "completed", "arm.completed", {
                  exit_code: 0,
                });
              }
            }
          } else if (exitCode !== null) {
            // Non-zero exit — drive starting → active → failed.
            const activated = await this.transitionArm(arm, "active", "arm.active");
            if (activated) {
              const updatedArm = this.registry.getArm(arm.arm_id);
              if (updatedArm) {
                const classified = this.classifyArmFailure(arm.arm_id);
                await this.transitionArm(updatedArm, "failed", "arm.failed", {
                  exit_code: exitCode,
                  reason: classified ?? `exit_code_${exitCode}`,
                });
              }
            }
          } else {
            // No sentinel yet, session gone. This could be a race:
            // fast-exiting commands finish before the sentinel wrapper
            // writes the exit code. Give a grace period of 3 poll ticks
            // before declaring failure.
            const graceKey = `sentinel-grace:${arm.arm_id}`;
            const graceCount = (this as unknown as Record<string, number>)[graceKey] ?? 0;
            if (graceCount < 3) {
              (this as unknown as Record<string, number>)[graceKey] = graceCount + 1;
              // Skip this tick — check again next time.
            } else {
              delete (this as unknown as Record<string, number>)[graceKey];
              await this.transitionArm(arm, "failed", "arm.failed", {
                reason: "session_not_found_on_poll",
              });
            }
          }
        }
      }
      // 4. Poll remote arms — arms with target_node label that are in
      //    starting state. Check their sentinel files via SSH.
      if (this.remoteNodes.size > 0) {
        const remoteArms = startingArms.filter(
          (arm) => arm.adapter_type === "pty_tmux" && arm.spec?.labels?.target_node,
        );
        if (remoteArms.length > 0) {
          this.log("info", "pollTick step4: polling remote arms", {
            remote_arm_count: remoteArms.length,
            remote_nodes: [...this.remoteNodes.keys()],
          });
        }
        for (const arm of remoteArms) {
          const targetNodeId = arm.spec.labels?.target_node;
          if (!targetNodeId) {
            continue;
          }
          const nodeConfig = this.remoteNodes.get(targetNodeId);
          if (!nodeConfig) {
            continue;
          }

          const remoteSentinelDir = nodeConfig.sentinelDir ?? "/tmp/octo-sentinels";
          const remoteSentinelPath = `${remoteSentinelDir}/${arm.arm_id}.exit`;
          const remoteOutputPath = `${remoteSentinelDir}/${arm.arm_id}.output`;

          try {
            const { execFile: execFileCb } = await import("node:child_process");
            const { promisify } = await import("node:util");
            const execFileAsync = promisify(execFileCb);

            // Build SSH args
            const sshArgs: string[] = ["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5"];
            if (nodeConfig.keyPath) {
              sshArgs.push("-i", nodeConfig.keyPath);
            }
            sshArgs.push(
              `${nodeConfig.user}@${nodeConfig.host}`,
              `cat ${remoteSentinelPath} 2>/dev/null || echo __PENDING__`,
            );

            let cmd: string;
            let cmdArgs: string[];
            if (nodeConfig.password) {
              cmd = "sshpass";
              cmdArgs = ["-p", nodeConfig.password, "ssh", ...sshArgs];
            } else {
              cmd = "ssh";
              cmdArgs = sshArgs;
            }

            const result = await execFileAsync(cmd, cmdArgs, { timeout: 10000 });
            const content = result.stdout.trim();

            if (content !== "__PENDING__" && /^-?\d+$/.test(content)) {
              const exitCode = parseInt(content, 10);
              const targetState = exitCode === 0 ? "completed" : "failed";

              // Pull output file from remote
              try {
                const pullArgs = [...sshArgs.slice(0, -1), `cat ${remoteOutputPath} 2>/dev/null`];
                let pullCmd: string;
                let pullCmdArgs: string[];
                if (nodeConfig.password) {
                  pullCmd = "sshpass";
                  pullCmdArgs = ["-p", nodeConfig.password, "ssh", ...pullArgs];
                } else {
                  pullCmd = "ssh";
                  pullCmdArgs = pullArgs;
                }
                const outputResult = await execFileAsync(pullCmd, pullCmdArgs, { timeout: 15000 });
                const localOutputPath = path.join(this.sentinelDir, `${arm.arm_id}.output`);
                writeFileSync(localOutputPath, outputResult.stdout);
              } catch {
                // Best effort output pull
              }

              // Write local sentinel
              const localSentinelPath = path.join(this.sentinelDir, `${arm.arm_id}.exit`);
              writeFileSync(localSentinelPath, String(exitCode));

              // Transition arm: starting → active → completed/failed
              const activated = await this.transitionArm(arm, "active", "arm.active");
              if (activated) {
                const updatedArm = this.registry.getArm(arm.arm_id);
                if (updatedArm) {
                  const classified =
                    targetState === "failed" ? this.classifyArmFailure(arm.arm_id) : null;
                  await this.transitionArm(
                    updatedArm,
                    targetState,
                    targetState === "completed" ? "arm.completed" : "arm.failed",
                    {
                      exit_code: exitCode,
                      remote_node: targetNodeId,
                      ...(classified ? { reason: classified } : {}),
                    },
                  );
                }
              }

              this.log("info", `remote arm ${targetState} on ${targetNodeId}`, {
                arm_id: arm.arm_id,
                exit_code: exitCode,
                remote_node: targetNodeId,
              });
            }
          } catch (err) {
            // SSH check failed — skip this tick, retry next.
            this.log("warn", "remote arm sentinel check failed", {
              arm_id: arm.arm_id,
              target_node: targetNodeId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private: ProcessWatcher event handling
  // ────────────────────────────────────────────────────────────────────────

  private async handleProcessEvent(event: ProcessWatcherEvent): Promise<void> {
    const arm = this.registry.getArm(event.arm_id);
    if (arm === null) {
      this.log("warn", "handleProcessEvent: arm not found in registry", {
        arm_id: event.arm_id,
        event_type: event.type,
      });
      return;
    }

    // Only transition if the arm is in a state that can go to failed/completed.
    if (
      arm.state === "failed" ||
      arm.state === "terminated" ||
      arm.state === "archived" ||
      arm.state === "completed"
    ) {
      // Already in a terminal-ish state -- nothing to do.
      return;
    }

    let succeeded: boolean;
    if (event.type === "completed") {
      // completed means exit code 0. For arms that are active, this
      // maps to the completed state.
      succeeded = await this.transitionArm(arm, "completed", "arm.completed", {
        exit_code: event.exit_code,
      });
    } else {
      // failed -- non-zero exit, sentinel missing, etc.
      succeeded = await this.transitionArm(arm, "failed", "arm.failed", {
        exit_code: event.exit_code,
        reason: event.reason,
      });
    }

    // Only unwatch when the transition actually succeeded. If it was
    // rejected (InvalidTransitionError) or lost a CAS race, keep the
    // watcher attached so a future event can retry.
    if (succeeded) {
      this.processWatcher.unwatch(event.arm_id);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private: FSM transition helper
  // ────────────────────────────────────────────────────────────────────────

  private async transitionArm(
    arm: ArmRecord,
    toState: "active" | "failed" | "completed",
    eventType: AppendInput["event_type"],
    extraPayload: Record<string, unknown> = {},
  ): Promise<boolean> {
    const now = this.nowFn();

    // FSM validate + produce new state.
    let transitioned: { state: string; updated_at: number };
    try {
      transitioned = applyArmTransition({ state: arm.state, updated_at: arm.updated_at }, toState, {
        now,
        arm_id: arm.arm_id,
      });
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        this.log("warn", "transitionArm: FSM rejected transition", {
          arm_id: arm.arm_id,
          from: arm.state,
          to: toState,
        });
        return false;
      }
      throw err;
    }

    // CAS update.
    try {
      this.registry.casUpdateArm(arm.arm_id, arm.version, {
        state: transitioned.state,
        updated_at: transitioned.updated_at,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        this.log("warn", "transitionArm: CAS conflict", {
          arm_id: arm.arm_id,
          expected_version: arm.version,
          actual_version: err.actualVersion,
        });
        return false;
      }
      throw err;
    }

    // Emit event.
    try {
      await this.eventLog.append({
        schema_version: 1,
        entity_type: "arm",
        entity_id: arm.arm_id,
        event_type: eventType,
        ts: new Date(now).toISOString(),
        actor: `node-agent:${this.nodeId}`,
        payload: {
          node_id: this.nodeId,
          previous_state: arm.state,
          new_state: toState,
          ...extraPayload,
        },
      });
    } catch (err) {
      // Best-effort event emission -- do not crash the loop.
      this.log("error", "transitionArm: eventLog.append failed", {
        arm_id: arm.arm_id,
        event_type: eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Cascade: when an arm completes, transition its current grip to completed.
    // This bridges the arm lifecycle (adapter layer) with the grip lifecycle
    // (head services layer). Without this, grips remain in assigned/running
    // state even after the arm successfully finishes work.
    if (toState === "completed" && arm.current_grip_id) {
      try {
        const grip = this.registry.getGrip(arm.current_grip_id);
        if (
          grip &&
          grip.status !== "completed" &&
          grip.status !== "abandoned" &&
          grip.status !== "archived"
        ) {
          // Drive grip through assigned→running→completed if needed.
          let currentState = grip.status;
          let currentVersion = grip.version;
          let currentUpdatedAt = grip.updated_at;

          // If still assigned, transition to running first.
          if (currentState === "assigned") {
            const running = applyGripTransition(
              { state: currentState, updated_at: currentUpdatedAt },
              "running",
              { now, grip_id: grip.grip_id },
            );
            const updated = this.registry.casUpdateGrip(grip.grip_id, currentVersion, {
              status: running.state,
              updated_at: running.updated_at,
            });
            currentState = updated.status;
            currentVersion = updated.version;
            currentUpdatedAt = updated.updated_at;
          }

          // Now transition to completed.
          if (currentState === "running") {
            const completed = applyGripTransition(
              { state: currentState, updated_at: currentUpdatedAt },
              "completed",
              { now, grip_id: grip.grip_id },
            );
            this.registry.casUpdateGrip(grip.grip_id, currentVersion, {
              status: completed.state,
              updated_at: completed.updated_at,
            });

            await this.eventLog.append({
              schema_version: 1,
              entity_type: "grip",
              entity_id: grip.grip_id,
              event_type: "grip.completed",
              ts: new Date(now).toISOString(),
              actor: `node-agent:${this.nodeId}`,
              payload: {
                arm_id: arm.arm_id,
                mission_id: arm.mission_id,
              },
            });
          }
        }
      } catch (err) {
        // Best-effort — grip cascade failure should not break the arm lifecycle.
        this.log("warn", "transitionArm: grip completion cascade failed", {
          arm_id: arm.arm_id,
          grip_id: arm.current_grip_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Phase cascade: after a grip completes, check if any downstream
      // grips in the mission graph just became eligible (all their
      // depends_on are completed). If so, and they have arm templates
      // in the mission spec, spawn arms for them. This drives the
      // competitive multi-phase pipeline: work → judge → verdict.
      try {
        const mission = this.registry.getMission(arm.mission_id);
        if (mission && mission.spec?.arm_templates && mission.spec.arm_templates.length > 0) {
          const allGrips = this.registry.listGrips({ mission_id: arm.mission_id });
          const gripsByRawId = new Map<string, (typeof allGrips)[0]>();
          for (const g of allGrips) {
            gripsByRawId.set(g.grip_id, g);
          }

          for (const graphNode of mission.spec.graph) {
            const nsGripId = `${arm.mission_id}/${graphNode.grip_id}`;
            const grip = gripsByRawId.get(nsGripId);
            if (!grip || grip.status !== "queued") {
              continue;
            }
            if (graphNode.depends_on.length === 0) {
              continue;
            }

            // Check if all dependencies are completed
            const allDepsCompleted = graphNode.depends_on.every((depId) => {
              const nsDep = `${arm.mission_id}/${depId}`;
              const dep = gripsByRawId.get(nsDep);
              return dep && (dep.status === "completed" || dep.status === "archived");
            });

            if (!allDepsCompleted) {
              continue;
            }

            // This grip just became eligible. Look up its arm template
            // from the persisted _arm_templates_by_grip metadata. This
            // map was stored by missionCreate from the strategy expander
            // and contains the correct judge/verdict prompts.
            const armTemplatesByGrip = (mission.metadata as Record<string, unknown>)
              ?._arm_templates_by_grip as Record<string, unknown[]> | undefined;

            // Read outputs from completed dependency grips so we can
            // inject them into the judge prompt via string substitution.
            const depOutputs: Record<string, string> = {};
            const os = await import("node:os");
            const fs = await import("node:fs");
            const pathMod = await import("node:path");
            const sentinelDir = pathMod.join(process.env.TMPDIR ?? "/tmp", "octo-sentinels");
            for (const depId of graphNode.depends_on) {
              const nsDep = `${arm.mission_id}/${depId}`;
              const depGrip = gripsByRawId.get(nsDep);
              if (depGrip?.assigned_arm_id) {
                const outputFile = pathMod.join(sentinelDir, `${depGrip.assigned_arm_id}.output`);
                try {
                  depOutputs[depId] = fs.readFileSync(outputFile, "utf8").trim();
                } catch {
                  depOutputs[depId] = "(output not captured)";
                }
              }
            }

            // Resolve templates for this grip
            const gripTemplates = armTemplatesByGrip?.[graphNode.grip_id] as
              | Array<{
                  adapter_type: string;
                  runtime_name: string;
                  agent_id: string;
                  cwd?: string;
                  runtime_options: unknown;
                  initial_input?: string;
                }>
              | undefined;

            if (!gripTemplates || gripTemplates.length === 0) {
              // No templates for this grip — skip
              continue;
            }

            for (const template of gripTemplates) {
              // Inject dependency outputs into the prompt so judges
              // can actually see the work they're reviewing.
              let prompt = template.initial_input ?? graphNode.grip_id;
              for (const [depId, output] of Object.entries(depOutputs)) {
                prompt = prompt.replace(`[Output will be provided from grip: ${depId}]`, output);
              }

              // Also resolve the same placeholders inside
              // runtime_options.args so the CLI invocation actually
              // carries the substituted prompt. Strategies pre-bake
              // the framed-with-placeholder prompt into args; here we
              // do the dependency-output substitution pass so the
              // resolved text reaches the runtime. Without this step
              // the cascade runs the framed-but-unresolved string,
              // which is the Bug 2 symptom from
              // mis-a58fc01e-60a5-43c9-b9ef-134cb42219bb.
              let rewrittenRuntimeOptions = template.runtime_options as Record<string, unknown>;
              const rtArgs = rewrittenRuntimeOptions?.args;
              if (Array.isArray(rtArgs)) {
                const resolvedArgs = rtArgs.map((a: unknown) => {
                  if (typeof a !== "string") {
                    return a;
                  }
                  let out = a;
                  for (const [depId, output] of Object.entries(depOutputs)) {
                    out = out.split(`[Output will be provided from grip: ${depId}]`).join(output);
                  }
                  return out;
                });
                rewrittenRuntimeOptions = { ...rewrittenRuntimeOptions, args: resolvedArgs };
              }

              const armIdempotencyKey = `${mission.mission_id}:${graphNode.grip_id}:${template.runtime_name}:auto`;
              try {
                const { OctoGatewayHandlers } = await import("../wire/gateway-handlers.js");
                const { TmuxManager } = await import("./tmux-manager.js");
                const { LeaseService } = await import("../head/leases.js");
                const { PolicyService } = await import("../head/policy.js");
                const { OctoLogger, consoleLoggerProvider } = await import("../head/logging.js");
                const { DEFAULT_OCTO_CONFIG } = await import("../config/schema.js");

                const tmuxManager = new TmuxManager();
                const leaseService = new LeaseService(
                  (this.registry as never)["db"] ?? null,
                  this.eventLog,
                  DEFAULT_OCTO_CONFIG.lease,
                );
                const policyLogger = new OctoLogger("octo:policy:cascade", consoleLoggerProvider);
                const policyService = new PolicyService(
                  DEFAULT_OCTO_CONFIG.policy,
                  new Map(),
                  policyLogger,
                );
                const handlers = new OctoGatewayHandlers({
                  registry: this.registry,
                  eventLog: this.eventLog,
                  tmuxManager,
                  nodeId: os.hostname(),
                  leaseService,
                  policyService: policyService as never,
                });

                await handlers.armSpawn({
                  idempotency_key: armIdempotencyKey,
                  spec: {
                    spec_version: 1,
                    mission_id: arm.mission_id,
                    adapter_type: template.adapter_type as
                      | "pty_tmux"
                      | "cli_exec"
                      | "structured_subagent"
                      | "structured_acp",
                    runtime_name: template.runtime_name,
                    agent_id: template.agent_id,
                    cwd: template.cwd ?? process.cwd(),
                    runtime_options: rewrittenRuntimeOptions,
                    idempotency_key: armIdempotencyKey,
                    initial_input: prompt,
                    labels: {
                      grip: nsGripId,
                      execution_mode: mission.spec.execution_mode ?? "direct_execute",
                      phase: "auto-cascade",
                    },
                  },
                });

                this.log("info", "phase cascade: spawned arm for newly eligible grip", {
                  mission_id: arm.mission_id,
                  grip_id: nsGripId,
                  runtime: template.runtime_name,
                });
              } catch (spawnErr) {
                this.log("warn", "phase cascade: failed to spawn arm for eligible grip", {
                  mission_id: arm.mission_id,
                  grip_id: nsGripId,
                  error: spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
                });
              }
            } // end for template
          }
        }
      } catch (err) {
        this.log("warn", "phase cascade check failed", {
          arm_id: arm.arm_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Mission completion: after a grip completes, check if ALL grips
      // for this mission are now completed. If so, transition the mission
      // from active → completed. This is the final piece of the lifecycle:
      // mission create → arm spawn → grip claim → work → arm done → grip done → mission done.
      try {
        const mission = this.registry.getMission(arm.mission_id);
        if (mission && mission.status === "active") {
          const allGrips = this.registry.listGrips({ mission_id: arm.mission_id });
          const allDone =
            allGrips.length > 0 &&
            allGrips.every((g) => g.status === "completed" || g.status === "archived");
          if (allDone) {
            // Resolve the output artifact — the terminal grip in the
            // DAG (no other grip depends on it). For competitive
            // missions this is `verdict`; for collaborative chains
            // it's the last round; for council it's `synthesize`; for
            // consensus it's `validate`. We compute it from the
            // mission's graph spec rather than using `allGrips[0]`
            // because grips inserted in the same millisecond batch
            // tie on `created_at` and SQLite's DESC sort returns them
            // in arbitrary order — that bug caused
            // mis-8fda8e96-3f20-47f5-a4fd-5c9ee6556dd6 to label
            // round-1's stdout as `_output_artifact` instead of
            // round-N's haiku file.
            const missionGraph = (mission.spec.graph ?? []) as Array<{
              grip_id: string;
              depends_on?: string[];
            }>;
            const allDependencies = new Set<string>();
            for (const node of missionGraph) {
              for (const dep of node.depends_on ?? []) {
                allDependencies.add(dep);
              }
            }
            const terminalGripIds = new Set(
              missionGraph
                .filter((node) => !allDependencies.has(node.grip_id))
                .map((node) => node.grip_id),
            );
            // Namespace the terminal grip ids with the mission id to
            // match the registry's storage convention.
            const terminalNamespacedIds = new Set(
              [...terminalGripIds].map((id) => `${mission.mission_id}/${id}`),
            );

            // Persist every completed arm's output into the durable
            // artifacts tree at ~/.openclaw/octo/artifacts/<mission>/ so
            // the outputs survive reboot (macOS wipes $TMPDIR). The
            // returned _output_artifact path points at the durable copy.
            const sentDir = path.join(process.env.TMPDIR ?? "/tmp", "octo-sentinels");
            const stateDir =
              process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
            const missionArtifactDir = path.join(stateDir, "octo", "artifacts", mission.mission_id);
            try {
              mkdirSync(missionArtifactDir, { recursive: true });
            } catch (err) {
              this.log("warn", "failed to create mission artifact dir", {
                mission_id: mission.mission_id,
                error: err instanceof Error ? err.message : String(err),
              });
            }

            this.log("info", "mission artifact promotion: begin", {
              mission_id: mission.mission_id,
              grip_count: allGrips.length,
              sent_dir: sentDir,
              mission_artifact_dir: missionArtifactDir,
            });

            let outputArtifactPath: string | undefined;
            let copiedCount = 0;
            let skippedNoArm = 0;
            let skippedNoSrc = 0;
            let copyErrors = 0;
            for (const grip of allGrips) {
              if (!grip.assigned_arm_id) {
                skippedNoArm++;
                continue;
              }
              // Also attempt to read a touched-files manifest for the
              // arm (Bug 3 fix): if the pty-tmux wrapper wrote one,
              // copy every listed file into a per-grip subdirectory in
              // the mission artifact tree. Files preserve their path
              // below the arm's working directory when possible.
              const touchedPath = path.join(sentDir, `${grip.assigned_arm_id}.touched-files`);
              const srcPath = path.join(sentDir, `${grip.assigned_arm_id}.output`);
              const hasTee = existsSync(srcPath);
              const hasManifest = existsSync(touchedPath);

              // Slug the grip_id so colons don't break `tree` and other
              // path-walking tools (colons are legal on APFS but fragile
              // elsewhere and awkward in shells).
              const gripSlug = grip.grip_id.replace(/[^A-Za-z0-9._-]+/g, "_");
              const gripSubdir = path.join(missionArtifactDir, gripSlug);
              try {
                mkdirSync(gripSubdir, { recursive: true });
              } catch {
                // ignore — will re-throw below if copy fails
              }

              if (!hasTee && !hasManifest) {
                skippedNoSrc++;
                this.log("warn", "artifact promotion: no tee or manifest for arm", {
                  mission_id: mission.mission_id,
                  grip_id: grip.grip_id,
                  arm_id: grip.assigned_arm_id,
                  checked_src: srcPath,
                  checked_manifest: touchedPath,
                });
                continue;
              }

              // Copy the tee stdout file if present.
              let teeCopied = false;
              const isTerminalGrip = terminalNamespacedIds.has(grip.grip_id);
              if (hasTee) {
                const teeDst = path.join(gripSubdir, `${grip.assigned_arm_id}.stdout.txt`);
                try {
                  copyFileSync(srcPath, teeDst);
                  teeCopied = true;
                  copiedCount++;
                  // Only set outputArtifactPath from a terminal grip;
                  // for grips with manifest files we'll prefer those
                  // below.
                  if (isTerminalGrip && !outputArtifactPath) {
                    outputArtifactPath = teeDst;
                  }
                } catch (err) {
                  copyErrors++;
                  this.log("warn", "artifact promotion: tee copy failed", {
                    arm_id: grip.assigned_arm_id,
                    grip_id: grip.grip_id,
                    src: srcPath,
                    dst: teeDst,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }

              // Copy manifest-listed files (Bug 3 filesystem capture).
              if (hasManifest) {
                try {
                  const manifest = readFileSync(touchedPath, "utf8");
                  const files = manifest
                    .split("\n")
                    .map((l) => l.trim())
                    .filter((l) => l.length > 0);
                  let filesCopied = 0;
                  for (const absSrc of files) {
                    try {
                      if (!existsSync(absSrc)) {
                        continue;
                      }
                      // Flatten to a single level under gripSubdir
                      // using the basename — good enough for
                      // Phase 1. Future: preserve relative paths
                      // below spec.cwd so directory trees survive.
                      const baseName = path.basename(absSrc);
                      const manifestDst = path.join(gripSubdir, baseName);
                      copyFileSync(absSrc, manifestDst);
                      filesCopied++;
                      copiedCount++;
                      // If this grip is a terminal node, prefer
                      // the first manifest file as the canonical
                      // output (the actual artifact, not the stdout
                      // summary).
                      if (isTerminalGrip) {
                        outputArtifactPath = manifestDst;
                      }
                    } catch (err) {
                      copyErrors++;
                      this.log("warn", "artifact promotion: manifest file copy failed", {
                        arm_id: grip.assigned_arm_id,
                        src: absSrc,
                        error: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }
                  this.log("info", "artifact promotion: manifest processed", {
                    grip_id: grip.grip_id,
                    arm_id: grip.assigned_arm_id,
                    files_total: files.length,
                    files_copied: filesCopied,
                    tee_copied: teeCopied,
                  });
                } catch (err) {
                  copyErrors++;
                  this.log("warn", "artifact promotion: manifest read failed", {
                    arm_id: grip.assigned_arm_id,
                    manifest: touchedPath,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            }

            this.log("info", "mission artifact promotion: done", {
              mission_id: mission.mission_id,
              copied_count: copiedCount,
              skipped_no_arm: skippedNoArm,
              skipped_no_src: skippedNoSrc,
              copy_errors: copyErrors,
              output_artifact_path: outputArtifactPath ?? "(null)",
            });

            const missionNext = applyMissionTransition(
              { state: mission.status, updated_at: mission.updated_at },
              "completed",
              { now, mission_id: mission.mission_id },
            );

            // Store the output artifact path in metadata so downstream
            // missions/campaigns can find it via mission show.
            const updatedMetadata = {
              ...(mission.metadata as Record<string, unknown>),
              _output_artifact: outputArtifactPath ?? null,
              _completed_at: new Date(now).toISOString(),
            };

            this.registry.casUpdateMission(mission.mission_id, mission.version, {
              status: missionNext.state,
              updated_at: missionNext.updated_at,
              metadata: updatedMetadata,
            });
            await this.eventLog.append({
              schema_version: 1,
              entity_type: "mission",
              entity_id: mission.mission_id,
              event_type: "mission.completed",
              ts: new Date(now).toISOString(),
              actor: `node-agent:${this.nodeId}`,
              payload: {
                grip_count: allGrips.length,
                output_artifact: outputArtifactPath ?? null,
              },
            });
            this.log("info", "mission completed — all grips done", {
              mission_id: mission.mission_id,
              grip_count: allGrips.length,
              output_artifact: outputArtifactPath,
            });

            // Elo update: if this is a competitive mission (has a
            // :verdict or :judge grip whose output parses as a verdict
            // JSON), record a game against the runtime ratings table.
            if (this.elo && outputArtifactPath) {
              try {
                const verdictText = readFileSync(outputArtifactPath, "utf8");
                const results = parseVerdictForElo(verdictText);
                if (results && results.length >= 2) {
                  const game = this.elo.recordGame({
                    game_id: `game-${mission.mission_id}`,
                    mission_id: mission.mission_id,
                    grip_id: allGrips[0].grip_id,
                    results,
                  });
                  this.log("info", "elo game recorded", {
                    mission_id: mission.mission_id,
                    winner: game.winner_runtime,
                    deltas: game.results.map((r) => `${r.runtime}:${r.delta.toFixed(1)}`),
                  });
                }
              } catch (err) {
                this.log("warn", "elo game recording failed", {
                  mission_id: mission.mission_id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
        }
      } catch (err) {
        this.log("warn", "transitionArm: mission completion check failed", {
          arm_id: arm.arm_id,
          mission_id: arm.mission_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return true;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private: ProcessWatcher watch helper
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Read the captured output file for an arm and classify a failure.
   * Returns null if no output or no signature matches. Called by the
   * failure paths in pollTick so operators see `auth_required` instead
   * of a generic `exit_code_1`.
   */
  private classifyArmFailure(arm_id: string): string | null {
    try {
      const outputPath = path.join(this.sentinelDir, `${arm_id}.output`);
      if (!existsSync(outputPath)) {
        return null;
      }
      const text = readFileSync(outputPath, "utf8");
      return classifyFailure(text);
    } catch {
      return null;
    }
  }

  private watchArm(arm: ArmRecord): void {
    const sessionName = `${this.sessionNamePrefix}${arm.arm_id}`;
    this.processWatcher.watch({
      arm_id: arm.arm_id,
      session_name: sessionName,
      exit_sentinel_path: this.sentinelPathForArm(arm.arm_id),
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private: logging
  // ────────────────────────────────────────────────────────────────────────

  private log(
    level: "info" | "warn" | "error",
    message: string,
    details?: Record<string, unknown>,
  ): void {
    if (this.logger !== undefined) {
      this.logger({ level, message, details });
    }
  }
}
