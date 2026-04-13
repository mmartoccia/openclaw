// `openclaw meet ...` — agent teleconference CLI wiring.
//
// This is the thin commander.js layer over src/commands/meet.ts. Every
// verb delegates straight to the business-logic module; this file
// exists only to translate commander's option-object shape into
// typed options, handle stdout formatting, and wire help text.
//
// Design constraint: no state lives in this file. If a verb needs
// shared state (meeting store, deps), it goes through MeetDeps.

import type { Command } from "commander";
import {
  defaultMeetDeps,
  dialMeeting,
  doctorMeet,
  formatDoctorResult,
  listMeetings,
  pickupMeeting,
  renderTranscript,
  sendTurn,
  showMeeting,
  wrapMeeting,
  type MeetDeps,
  type MeetingStatus,
} from "../../commands/meet.js";
import { theme } from "../../terminal/theme.js";
import { formatHelpExamples } from "../help-format.js";

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asMeetingStatus(v: unknown): MeetingStatus | "all" | undefined {
  if (typeof v !== "string") {
    return undefined;
  }
  if (v === "pending" || v === "active" || v === "closed" || v === "all") {
    return v;
  }
  return undefined;
}

function emit(payload: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${String(payload)}\n`);
  }
}

export function registerMeetCommands(program: Command, deps: MeetDeps = defaultMeetDeps()): void {
  const meet = program
    .command("meet")
    .description("Agent teleconference — scoped multi-turn meetings between agents")
    .addHelpText(
      "after",
      () => `
${theme.heading("Examples:")}
${formatHelpExamples([
  [
    'openclaw meet dial --to claude-code --topic "sentinel polling review" --from openclaw-main --from-channel telegram --from-chat 1234567890',
    "Request a meeting with claude-code; the file lands in ~/.openclaw/meetings/pending/",
  ],
  ["openclaw meet list --state pending", "Show pending meetings waiting for pickup."],
  [
    "openclaw meet pickup --meeting mtg_17760 … --picked-up-by claude-code-session-1",
    "Claim a pending meeting so you can start sending turns.",
  ],
  [
    'openclaw meet send --meeting mtg_17760 … --message "Here are the three questions I have..."',
    "Send one framed turn and let --deliver post both sides to the channel.",
  ],
  [
    'openclaw meet wrap --meeting mtg_17760 … --outcome "Root cause fixed, commit abc123"',
    "Close the meeting and post the wrap frame.",
  ],
])}
`,
    );

  // ── dial ─────────────────────────────────────────────────────────────
  meet
    .command("dial")
    .description("Request a meeting — creates a pending-meeting file")
    .requiredOption("--to <agent>", "Target agent id (e.g. claude-code, main)")
    .requiredOption("--topic <text>", "Short topic / question for the meeting")
    .option("--context <text>", "Optional longer context")
    .option("--from <agent>", "Caller agent id (defaults to $OPENCLAW_AGENT_ID or 'unknown')")
    .option("--from-channel <channel>", "Caller's channel (default: cli)")
    .option("--from-chat <id>", "Caller's chat_id (required if replies should route back)")
    .option(
      "--reply-via <channel:chat>",
      "Override reply routing (default: from-channel:from-chat)",
    )
    .option("--json", "Output JSON instead of human-readable", false)
    .action((opts) => {
      const result = dialMeeting(deps, {
        to: String(opts.to),
        topic: String(opts.topic),
        context: stringOrUndef(opts.context),
        from: stringOrUndef(opts.from),
        fromChannel: stringOrUndef(opts.fromChannel),
        fromChat: stringOrUndef(opts.fromChat),
        replyVia: stringOrUndef(opts.replyVia),
      });
      if (opts.json) {
        emit({ meeting: result.meeting, path: result.path }, true);
      } else {
        emit(
          [
            `meeting_id: ${result.meeting.meeting_id}`,
            `file:       ${result.path}`,
            `to:         ${result.meeting.to_agent}`,
            `topic:      ${result.meeting.topic}`,
            ...(result.meeting.reply_via ? [`reply_via:  ${result.meeting.reply_via}`] : []),
          ].join("\n"),
          false,
        );
      }
    });

  // ── pickup ───────────────────────────────────────────────────────────
  meet
    .command("pickup")
    .description("Claim a pending meeting (moves pending → active)")
    .requiredOption("--meeting <id>", "Meeting id to pick up")
    .option("--picked-up-by <agent>", "Picker-up agent id (default: $OPENCLAW_AGENT_ID)")
    .option("--json", "Output JSON instead of human-readable", false)
    .action((opts) => {
      const result = pickupMeeting(deps, {
        meeting: String(opts.meeting),
        pickedUpBy: stringOrUndef(opts.pickedUpBy),
      });
      if (opts.json) {
        emit(
          { meeting: result.meeting, path: result.path, previous_state: result.previousState },
          true,
        );
      } else {
        emit(
          [
            `picked up:  ${result.meeting.meeting_id}`,
            `prev state: ${result.previousState}`,
            `new state:  ${result.meeting.status}`,
            `file:       ${result.path}`,
          ].join("\n"),
          false,
        );
      }
    });

  // ── send ─────────────────────────────────────────────────────────────
  meet
    .command("send")
    .description("Send a turn within an active meeting (posts both sides via --deliver)")
    .requiredOption("--meeting <id>", "Active meeting id")
    .requiredOption("--message <text>", "Message body")
    .option("--from <agent>", "Override the 'from' speaker id shown in the frame")
    .option("--from-icon <emoji>", "Emoji for the sender (default: 🤖)")
    .option("--to-icon <emoji>", "Emoji for the recipient (default: 🦾)")
    .option("--raw", "Skip visible frame wrapping (send the message body verbatim)", false)
    .option("--json", "Output JSON instead of human-readable", false)
    .action(async (opts) => {
      const result = await sendTurn(deps, {
        meeting: String(opts.meeting),
        message: String(opts.message),
        from: stringOrUndef(opts.from),
        fromIcon: stringOrUndef(opts.fromIcon),
        toIcon: stringOrUndef(opts.toIcon),
        raw: Boolean(opts.raw),
      });
      if (opts.json) {
        emit(
          {
            meeting_id: result.meeting.meeting_id,
            turns: result.meeting.turns,
            delivered: result.deliveredText,
            reply: result.replyText,
          },
          true,
        );
      } else {
        emit(
          [
            `meeting:  ${result.meeting.meeting_id}`,
            `turns:    ${result.meeting.turns ?? 0}`,
            `reply:    ${result.replyText.slice(0, 500)}${result.replyText.length > 500 ? "…" : ""}`,
          ].join("\n"),
          false,
        );
      }
    });

  // ── wrap ─────────────────────────────────────────────────────────────
  meet
    .command("wrap")
    .description("Close an active meeting (moves active → closed and posts the wrap frame)")
    .requiredOption("--meeting <id>", "Meeting id to wrap")
    .option("--outcome <text>", "One-line outcome summary")
    .option("--silent", "Do not post the wrap frame back to the channel", false)
    .option("--json", "Output JSON instead of human-readable", false)
    .action(async (opts) => {
      const result = await wrapMeeting(deps, {
        meeting: String(opts.meeting),
        outcome: stringOrUndef(opts.outcome),
        silent: Boolean(opts.silent),
      });
      if (opts.json) {
        emit({ meeting: result.meeting, path: result.path }, true);
      } else {
        emit(
          [
            `wrapped:  ${result.meeting.meeting_id}`,
            `outcome:  ${result.meeting.outcome ?? "(none)"}`,
            `turns:    ${result.meeting.turns ?? 0}`,
            `file:     ${result.path}`,
          ].join("\n"),
          false,
        );
      }
    });

  // ── list ─────────────────────────────────────────────────────────────
  meet
    .command("list")
    .description("List meetings by state")
    .option("--state <state>", "pending | active | closed | all (default: pending)")
    .option("--to <agent>", "Filter by target agent id")
    .option("--json", "Output JSON instead of human-readable", false)
    .action((opts) => {
      const state = asMeetingStatus(opts.state) ?? "pending";
      const meetings = listMeetings(deps, {
        state,
        to: stringOrUndef(opts.to),
      });
      if (opts.json) {
        emit(meetings, true);
        return;
      }
      if (meetings.length === 0) {
        emit("(no meetings)", false);
        return;
      }
      const lines: string[] = [];
      for (const m of meetings) {
        lines.push(
          `[${m.status.padEnd(7)}] ${m.meeting_id}`,
          `         ${m.from_agent} → ${m.to_agent}`,
          `         topic: ${m.topic}`,
          `         at:    ${m.created_at}`,
        );
        if (m.context.trim()) {
          lines.push(`         context: ${m.context}`);
        }
        if (m.reply_via) {
          lines.push(`         reply_via: ${m.reply_via}`);
        }
        lines.push("");
      }
      emit(lines.join("\n").trimEnd(), false);
    });

  // ── show ─────────────────────────────────────────────────────────────
  meet
    .command("show")
    .description("Show one meeting's full details as JSON")
    .requiredOption("--meeting <id>", "Meeting id to show")
    .action((opts) => {
      const meeting = showMeeting(deps, String(opts.meeting));
      emit(meeting, true);
    });

  // ── transcript ───────────────────────────────────────────────────────
  meet
    .command("transcript")
    .description("Render a meeting's transcript with visual frames")
    .requiredOption("--meeting <id>", "Meeting id to render")
    .action((opts) => {
      const meeting = showMeeting(deps, String(opts.meeting));
      emit(renderTranscript(meeting), false);
    });

  // ── doctor ───────────────────────────────────────────────────────────
  // Smoke-test the meet bridge end-to-end. Intended to run on demand
  // (when something feels off) or on gateway start to catch silent
  // protocol drift like the 2026-04-12 body-post regression.
  //
  // Local-only mode (no flags): verifies the filesystem state machine.
  // Channel mode (--channel + --target): additionally runs a real turn
  // through the given channel and records which specific step fails
  // if the bridge drifts.
  meet
    .command("doctor")
    .description("Smoke-test the meet bridge end-to-end (dial → pickup → send → wrap)")
    .option("--channel <channel>", "Channel to test (e.g. telegram); omit for local-only check")
    .option(
      "--target <id>",
      "Target chat/account id for the channel test (required with --channel)",
    )
    .option("--no-cleanup", "Leave the test meeting in active/ instead of wrapping it", false)
    .option("--json", "Output JSON instead of human-readable", false)
    .action(async (opts) => {
      const channel = stringOrUndef(opts.channel);
      const target = stringOrUndef(opts.target);
      if (channel && !target) {
        process.stderr.write("meet doctor: --target is required when --channel is set\n");
        process.exit(2);
      }
      const result = await doctorMeet(deps, {
        channel,
        target,
        cleanup: opts.cleanup !== false,
      });
      if (opts.json) {
        emit(result, true);
      } else {
        emit(formatDoctorResult(result), false);
      }
      process.exit(result.ok ? 0 : 1);
    });
}
