// /octo chat slash command handler.
//
// Dispatches "/octo <action> [subaction] [args...]" by reaching into the
// OctopusInstance registered at src/octo/runtime-registry.ts. The Gateway
// populates that registry inside initOctopus() during startup; this handler
// reads it per-request and returns early if octo is disabled / failed init.
//
// Supported actions (read-only by default):
//   status                          — dashboard snapshot
//   mission list | mission show <id>
//   arm list | arm show <id>
//   grip list | grip show <id>
//   doctor                          — quick health check
//
// Mutating actions (mission create / abort / pause / resume, arm spawn /
// terminate) stay on the `openclaw octo ...` CLI for now; the chat surface
// is intentionally read-biased until we have an approval gate in place.

import { logVerbose } from "../../globals.js";
import { getOctoRuntimeInstance } from "../../octo/runtime-registry.js";
import { requireGatewayClientScopeForInternalChannel } from "./command-gates.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

const COMMAND = "/octo";

const HELP_TEXT = [
  "Usage: /octo <action> [args]",
  "",
  "Read-only actions:",
  "  status                    Dashboard snapshot",
  "  mission list              List all missions",
  "  mission show <id>         Show mission detail",
  "  arm list                  List all arms",
  "  arm show <id>             Show arm detail",
  "  grip list                 List all grips",
  "  grip show <id>            Show grip detail",
  "  elo                       Runtime Elo rating table",
  "  doctor                    Quick health check",
  "",
  "Mutating actions (create/abort/spawn/terminate) remain on the CLI:",
  "  openclaw octo mission create ...",
].join("\n");

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
        return stopWithText("Usage: /octo mission list | /octo mission show <id>");
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
        return stopWithText("Usage: /octo arm list | /octo arm show <id>");
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
