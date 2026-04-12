// /octo chat slash command handler.
//
// Dispatches "/octo <action> [subaction] [args...]" by reaching into the
// OctopusInstance registered at src/octo/runtime-registry.ts. The Gateway
// populates that registry inside initOctopus() during startup; this handler
// reads it per-request and returns early if octo is disabled / failed init.
//
// Supported actions:
//   Read-only:
//     status, mission list/show, arm list/show, grip list/show, elo, doctor
//   Mutating (require `--yes` suffix to confirm):
//     mission abort <id> --yes
//     arm terminate <id> --yes
//
// Approval gate: mutating actions are a two-step confirm. Without --yes,
// the handler prints a preview of what would happen and refuses. With
// --yes, it goes through. This is the simplest single-turn gate that
// doesn't require threading an ApprovalRequest state machine through the
// reply pipeline. Mission-create stays on the CLI — too many parameters
// to make a clean one-liner in chat.

import { logVerbose } from "../../globals.js";
import { getOctoRuntimeInstance } from "../../octo/runtime-registry.js";
import { requireGatewayClientScopeForInternalChannel } from "./command-gates.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

const COMMAND = "/octo";

const HELP_TEXT = [
  "Usage: /octo <action> [args]",
  "",
  "Read-only actions:",
  "  status                        Dashboard snapshot",
  "  mission list                  List all missions",
  "  mission show <id>             Show mission detail",
  "  arm list                      List all arms",
  "  arm show <id>                 Show arm detail",
  "  grip list                     List all grips",
  "  grip show <id>                Show grip detail",
  "  elo                           Runtime Elo rating table",
  "  doctor                        Quick health check",
  "",
  "Mutating actions (require --yes to confirm):",
  "  mission abort <id> --yes      Abort a running mission",
  "  mission pause <id> --yes      Pause mission execution",
  "  mission resume <id> --yes     Resume a paused mission",
  "  arm terminate <id> --yes      Terminate a single arm",
  "",
  "Mission creation stays on the CLI (too many params for chat):",
  "  openclaw octo mission create ...",
].join("\n");

const YES_TOKEN = "--yes";

function hasYesFlag(args: string[]): boolean {
  return args.includes(YES_TOKEN);
}

function stripYesFlag(args: string[]): string[] {
  return args.filter((a) => a !== YES_TOKEN);
}

function stopWithText(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

function fenceBlock(body: string): string {
  return "```\n" + body.replace(/```/g, "'''") + "\n```";
}

function truncate(text: string, max = 3500): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max) + `\n… (${text.length - max} more chars truncated)`;
}

export const handleOctoCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const normalized = params.command.commandBodyNormalized;
  if (normalized !== COMMAND && !normalized.startsWith(COMMAND + " ")) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /octo from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  // /octo is operator-level functionality; gate the internal channel the
  // same way /acp does for mutating actions. Read-only status is still
  // restricted — treat all of it as operator.admin for now.
  const scopeBlock = requireGatewayClientScopeForInternalChannel(params, {
    label: "/octo",
    allowedScopes: ["operator.admin"],
    missingText: "This /octo action requires operator.admin on the internal channel.",
  });
  if (scopeBlock) {
    return scopeBlock;
  }

  const rest = normalized.slice(COMMAND.length).trim();
  const tokens = rest.split(/\s+/).filter(Boolean);

  if (tokens.length === 0 || tokens[0] === "help") {
    return stopWithText(HELP_TEXT);
  }

  const octo = getOctoRuntimeInstance();
  if (!octo) {
    return stopWithText(
      "Octopus Orchestrator is not enabled on this gateway.\n" +
        "Set `octo.enabled: true` in ~/.openclaw/openclaw.json and restart the gateway.",
    );
  }

  const action = tokens[0];
  const subaction = tokens[1];
  const args = tokens.slice(2);

  try {
    switch (action) {
      case "status": {
        const { gatherOctoStatus, formatOctoStatus } = await import("../../octo/cli/status.js");
        const result = gatherOctoStatus(octo.services.registry);
        return stopWithText(fenceBlock(truncate(formatOctoStatus(result))));
      }

      case "elo": {
        const ratings = octo.services.elo.listRatings();
        if (ratings.length === 0) {
          return stopWithText(
            "No Elo ratings yet. Run a competitive mission to populate the table.",
          );
        }
        const header = "runtime".padEnd(16) + "rating   games   W  L  T";
        const lines = [header, "-".repeat(header.length)];
        for (const r of ratings) {
          lines.push(
            `${r.runtime_name.padEnd(16)}${r.rating.toFixed(1).padStart(7)}  ${String(
              r.games,
            ).padStart(5)}  ${String(r.wins).padStart(2)} ${String(r.losses).padStart(2)} ${String(
              r.ties,
            ).padStart(2)}`,
          );
        }
        return stopWithText(fenceBlock(truncate(lines.join("\n"))));
      }

      case "doctor": {
        const { runOctoDoctor } = await import("../../octo/cli/doctor.js");
        const buf: string[] = [];
        const out = { write: (s: string) => buf.push(s) };
        runOctoDoctor({}, out);
        return stopWithText(fenceBlock(truncate(buf.join(""))));
      }

      case "mission": {
        if (!subaction || subaction === "list") {
          const missions = octo.services.registry.listMissions();
          if (missions.length === 0) {
            return stopWithText("No missions.");
          }
          const lines = missions.map(
            (m) => `${m.mission_id}  ${m.status.padEnd(10)} ${m.title ?? "(untitled)"}`,
          );
          return stopWithText(fenceBlock(truncate(lines.join("\n"))));
        }
        if (subaction === "show") {
          if (args.length === 0) {
            return stopWithText("Usage: /octo mission show <mission_id>");
          }
          const mission = octo.services.registry.getMission(args[0]);
          if (!mission) {
            return stopWithText(`mission not found: ${args[0]}`);
          }
          return stopWithText(fenceBlock(truncate(JSON.stringify(mission, null, 2))));
        }
        if (subaction === "abort" || subaction === "pause" || subaction === "resume") {
          const confirmed = hasYesFlag(args);
          const stripped = stripYesFlag(args);
          if (stripped.length === 0) {
            return stopWithText(`Usage: /octo mission ${subaction} <mission_id> --yes`);
          }
          const missionId = stripped[0];
          const mission = octo.services.registry.getMission(missionId);
          if (!mission) {
            return stopWithText(`mission not found: ${missionId}`);
          }
          if (!confirmed) {
            const arms = octo.services.registry.listArms({ mission_id: missionId });
            const live = arms.filter((a) => a.state === "starting" || a.state === "active").length;
            return stopWithText(
              `About to ${subaction} mission ${missionId}:\n` +
                `  title:  ${mission.title}\n` +
                `  status: ${mission.status}\n` +
                `  arms:   ${arms.length} total, ${live} live\n\n` +
                `Re-run with --yes to confirm:\n` +
                `  /octo mission ${subaction} ${missionId} --yes`,
            );
          }
          const idempotencyKey = `chat-${subaction}-${missionId}-${Date.now()}`;
          if (subaction === "abort") {
            const res = await octo.services.handlers.missionAbort({
              idempotency_key: idempotencyKey,
              mission_id: missionId,
              reason: `chat: /octo mission abort by ${params.command.senderId ?? "operator"}`,
            });
            return stopWithText(
              `Mission ${res.mission_id} aborted. Arms terminated: ${res.arms_terminated}`,
            );
          }
          if (subaction === "pause") {
            const res = await octo.services.handlers.missionPause({
              idempotency_key: idempotencyKey,
              mission_id: missionId,
            });
            return stopWithText(`Mission ${res.mission_id} paused.`);
          }
          const res = await octo.services.handlers.missionResume({
            idempotency_key: idempotencyKey,
            mission_id: missionId,
          });
          return stopWithText(`Mission ${res.mission_id} resumed.`);
        }
        return stopWithText(
          "Usage: /octo mission list | show <id> | abort <id> --yes | pause <id> --yes | resume <id> --yes",
        );
      }

      case "arm": {
        if (!subaction || subaction === "list") {
          const arms = octo.services.registry.listArms();
          if (arms.length === 0) {
            return stopWithText("No arms.");
          }
          const lines = arms.map(
            (a) => `${a.arm_id}  ${a.state.padEnd(10)} ${a.agent_id ?? "-"}  ${a.adapter_type}`,
          );
          return stopWithText(fenceBlock(truncate(lines.join("\n"))));
        }
        if (subaction === "show") {
          if (args.length === 0) {
            return stopWithText("Usage: /octo arm show <arm_id>");
          }
          const arm = octo.services.registry.getArm(args[0]);
          if (!arm) {
            return stopWithText(`arm not found: ${args[0]}`);
          }
          return stopWithText(fenceBlock(truncate(JSON.stringify(arm, null, 2))));
        }
        if (subaction === "terminate") {
          const confirmed = hasYesFlag(args);
          const stripped = stripYesFlag(args);
          if (stripped.length === 0) {
            return stopWithText("Usage: /octo arm terminate <arm_id> --yes");
          }
          const armId = stripped[0];
          const arm = octo.services.registry.getArm(armId);
          if (!arm) {
            return stopWithText(`arm not found: ${armId}`);
          }
          if (!confirmed) {
            return stopWithText(
              `About to terminate arm ${armId}:\n` +
                `  mission: ${arm.mission_id}\n` +
                `  agent:   ${arm.agent_id}\n` +
                `  state:   ${arm.state}\n` +
                `  adapter: ${arm.adapter_type}\n\n` +
                `Re-run with --yes to confirm:\n` +
                `  /octo arm terminate ${armId} --yes`,
            );
          }
          const res = await octo.services.handlers.armTerminate({
            idempotency_key: `chat-terminate-${armId}-${Date.now()}`,
            arm_id: armId,
            reason: `chat: /octo arm terminate by ${params.command.senderId ?? "operator"}`,
          });
          return stopWithText(
            `Arm ${res.arm_id} terminated=${res.terminated} final=${res.final_status}.`,
          );
        }
        return stopWithText("Usage: /octo arm list | show <id> | terminate <id> --yes");
      }

      case "grip": {
        if (!subaction || subaction === "list") {
          const grips = octo.services.registry.listGrips();
          if (grips.length === 0) {
            return stopWithText("No grips.");
          }
          const lines = grips.map(
            (g) => `${g.grip_id}  ${g.status.padEnd(10)} mission=${g.mission_id}`,
          );
          return stopWithText(fenceBlock(truncate(lines.join("\n"))));
        }
        if (subaction === "show") {
          if (args.length === 0) {
            return stopWithText("Usage: /octo grip show <grip_id>");
          }
          const grip = octo.services.registry.getGrip(args[0]);
          if (!grip) {
            return stopWithText(`grip not found: ${args[0]}`);
          }
          return stopWithText(fenceBlock(truncate(JSON.stringify(grip, null, 2))));
        }
        return stopWithText("Usage: /octo grip list | /octo grip show <id>");
      }

      default:
        return stopWithText(`Unknown /octo action: ${action}\n\n${HELP_TEXT}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return stopWithText(`/octo ${action} failed: ${msg}`);
  }
};
