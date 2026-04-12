// Agent Teleconference — meeting CLI business logic.
//
// Wraps the `openclaw agent --to <chat> --deliver` pattern into explicit
// verbs with a persisted lifecycle. See:
//
//   docs/octopus-orchestrator/AGENT-TELECONFERENCE.md
//   docs/octopus-orchestrator/TELECONFERENCE-DIAL.md
//
// Design notes:
//
// - Meetings live in ~/.openclaw/meetings/{pending,active,closed}/
//   as JSON files. Lifecycle state is the containing directory. Status
//   transitions are atomic file moves — no locks, no partial-write
//   corruption, no schema drift between "field said closed" vs "file
//   was in closed dir". This matches the shell prototype at
//   scripts/teleconference/meet-dial.sh so the two implementations are
//   format-interoperable.
//
// - `send` deliberately shells out to `openclaw agent --to --deliver`
//   rather than importing agent-via-gateway.ts directly. Two reasons:
//   (1) keeps this module self-contained and easy to test with a mock
//   child-process executor; (2) avoids coupling the prototype to the
//   gateway-dispatch runtime surface, which is heavier than we need.
//   Graduation path is to inline agentCliCommand once this lands
//   upstream.
//
// - Classic Telegram Markdown is used for visual frames. The telegram
//   plugin already defaults to `parse_mode: Markdown`, so `*bold*`,
//   `` `code` ``, triple-backtick blocks, and emojis render directly.
//   No MarkdownV2 escaping required (this was verified live on
//   2026-04-12; see docs/octopus-orchestrator/AGENT-TELECONFERENCE.md).

import { execFile as execFileCb } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join as pathJoin } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type MeetingStatus = "pending" | "active" | "closed";

/**
 * Persisted shape of a meeting file. Kept intentionally flat so it's
 * easy to diff and easy to reconstruct by hand if tooling is broken.
 *
 * All optional fields are populated as the meeting moves through its
 * lifecycle — `started_at`/`picked_up_by` on pickup, `ended_at`/
 * `outcome`/`turns` on wrap. Fields are NEVER removed; a closed
 * meeting always carries every field from its dial and pickup.
 */
export interface MeetingFile {
  meeting_id: string;
  from_agent: string;
  from_channel: string;
  from_chat_id: string;
  to_agent: string;
  topic: string;
  context: string;
  reply_via: string;
  created_at: string;
  status: MeetingStatus;
  started_at?: string;
  picked_up_by?: string;
  ended_at?: string;
  outcome?: string;
  turns?: number;
  /**
   * Append-only turn log captured inside the meeting file itself. Each
   * entry is one `send` call: who spoke, when, to whom, the message
   * body, and optionally the reply. Used by `transcript` and by future
   * search/replay tooling.
   */
  transcript?: MeetingTurn[];
}

export interface MeetingTurn {
  ts: string;
  from: string;
  to: string;
  body: string;
  reply?: string;
}

/**
 * Injectable dependencies. Tests construct a MeetDeps with overrides
 * for the file system, clock, random, and the agent-turn executor;
 * production code calls `defaultMeetDeps()` to get the real versions.
 */
export interface MeetDeps {
  homedir: () => string;
  now: () => Date;
  randHex: (bytes: number) => string;
  /**
   * Execute an agent turn via `openclaw agent --to --deliver ...` and
   * return the stdout JSON. Isolated behind a function so tests can
   * mock it without spawning a real child process.
   */
  runAgentTurn: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /**
   * Overridable read of the current process env. Callers can inject
   * a frozen env for tests.
   */
  env: () => NodeJS.ProcessEnv;
}

export function defaultMeetDeps(): MeetDeps {
  return {
    homedir: () => osHomedir(),
    now: () => new Date(),
    randHex: (bytes) => randomBytes(bytes).toString("hex"),
    runAgentTurn: async (args) => {
      const { stdout, stderr } = await execFile("openclaw", args, {
        maxBuffer: 32 * 1024 * 1024,
        timeout: 10 * 60 * 1000,
      });
      return { stdout, stderr };
    },
    env: () => process.env,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Path helpers
// ──────────────────────────────────────────────────────────────────────────

function meetingsRoot(deps: MeetDeps): string {
  const overrideRoot = deps.env().OPENCLAW_MEETINGS_DIR?.trim();
  if (overrideRoot && overrideRoot.length > 0) {
    return overrideRoot;
  }
  return pathJoin(deps.homedir(), ".openclaw", "meetings");
}

function dirForState(deps: MeetDeps, state: MeetingStatus): string {
  return pathJoin(meetingsRoot(deps), state);
}

function ensureDirs(deps: MeetDeps): void {
  for (const state of ["pending", "active", "closed"] as const) {
    mkdirSync(dirForState(deps, state), { recursive: true });
  }
}

function isoTimestamp(deps: MeetDeps): string {
  return deps
    .now()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

function generateMeetingId(deps: MeetDeps): string {
  const nowMs = deps.now().getTime();
  const rand = deps.randHex(3);
  return `mtg_${nowMs}_${rand}`;
}

/**
 * Find the state + file path for a meeting id, searching pending →
 * active → closed. Returns null if no file exists.
 */
function findMeetingFile(
  deps: MeetDeps,
  meetingId: string,
): { state: MeetingStatus; path: string } | null {
  for (const state of ["pending", "active", "closed"] as const) {
    const candidate = pathJoin(dirForState(deps, state), `${meetingId}.json`);
    if (existsSync(candidate)) {
      return { state, path: candidate };
    }
  }
  return null;
}

function readMeeting(path: string): MeetingFile {
  return JSON.parse(readFileSync(path, "utf8")) as MeetingFile;
}

function writeMeeting(path: string, doc: MeetingFile): void {
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

function moveMeeting(
  deps: MeetDeps,
  meetingId: string,
  fromPath: string,
  toState: MeetingStatus,
): string {
  const toPath = pathJoin(dirForState(deps, toState), `${meetingId}.json`);
  renameSync(fromPath, toPath);
  return toPath;
}

// ──────────────────────────────────────────────────────────────────────────
// Visual frames
// ──────────────────────────────────────────────────────────────────────────

const HR = "━━━━━━━━━━━━━━━━━━━━━";

function openFrame(m: MeetingFile, initiatorIcon: string, targetIcon: string): string {
  return [
    `🎤 *MEETING OPENED*`,
    HR,
    `*Topic:* ${m.topic}`,
    `*Participants:* ${initiatorIcon} ${m.from_agent} ↔ ${targetIcon} ${m.to_agent}`,
    `*Meeting ID:* \`${m.meeting_id}\``,
    HR,
  ].join("\n");
}

function speakerFrame(
  from: string,
  to: string,
  body: string,
  fromIcon: string,
  toIcon: string,
): string {
  return [`${fromIcon} → ${toIcon} *${from} → ${to}*`, HR, body, HR].join("\n");
}

function wrapFrame(m: MeetingFile): string {
  const parts: string[] = [
    `🔚 *MEETING WRAPPED*`,
    HR,
    `*Meeting ID:* \`${m.meeting_id}\``,
    `*Topic:* ${m.topic}`,
  ];
  if (m.turns !== undefined) {
    parts.push(`*Turns:* ${m.turns}`);
  }
  if (m.outcome) {
    parts.push(`*Outcome:* ${m.outcome}`);
  }
  parts.push(HR);
  return parts.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Verb implementations
// ──────────────────────────────────────────────────────────────────────────

export interface DialOptions {
  to: string;
  topic: string;
  context?: string;
  from?: string;
  fromChannel?: string;
  fromChat?: string;
  replyVia?: string;
}

export interface DialResult {
  meeting: MeetingFile;
  path: string;
}

/**
 * Create a pending meeting request file. Does NOT trigger any agent
 * turn or channel post — this is the handoff primitive: one agent
 * dials, the file lands in pending/, and any session can pick it up
 * later via `pickup`.
 *
 * The `reply_via` hint tells the picker-up how to route its reply back
 * to the dialer's channel. Defaults to `<from_channel>:<from_chat>`.
 */
export function dialMeeting(deps: MeetDeps, opts: DialOptions): DialResult {
  if (!opts.to || !opts.to.trim()) {
    throw new Error("meet dial: --to is required");
  }
  if (!opts.topic || !opts.topic.trim()) {
    throw new Error("meet dial: --topic is required");
  }

  ensureDirs(deps);

  const from = opts.from ?? deps.env().OPENCLAW_AGENT_ID ?? "unknown";
  const fromChannel = opts.fromChannel ?? "cli";
  const fromChat = opts.fromChat ?? "";
  const replyVia = opts.replyVia ?? (fromChat ? `${fromChannel}:${fromChat}` : "");

  const meeting: MeetingFile = {
    meeting_id: generateMeetingId(deps),
    from_agent: from,
    from_channel: fromChannel,
    from_chat_id: fromChat,
    to_agent: opts.to,
    topic: opts.topic,
    context: opts.context ?? "",
    reply_via: replyVia,
    created_at: isoTimestamp(deps),
    status: "pending",
  };

  const path = pathJoin(dirForState(deps, "pending"), `${meeting.meeting_id}.json`);
  writeMeeting(path, meeting);
  return { meeting, path };
}

export interface PickupOptions {
  meeting: string;
  pickedUpBy?: string;
}

export interface PickupResult {
  meeting: MeetingFile;
  path: string;
  previousState: MeetingStatus;
}

/**
 * Move a meeting from pending → active. Records the pickup timestamp
 * and the agent id of the picker-up. Idempotent: if the meeting is
 * already active, it's returned as-is. Throws if the meeting is
 * closed or doesn't exist.
 */
export function pickupMeeting(deps: MeetDeps, opts: PickupOptions): PickupResult {
  const found = findMeetingFile(deps, opts.meeting);
  if (!found) {
    throw new Error(`meet pickup: meeting not found: ${opts.meeting}`);
  }
  if (found.state === "closed") {
    throw new Error(`meet pickup: meeting ${opts.meeting} is already closed; cannot pick up`);
  }
  const meeting = readMeeting(found.path);
  if (found.state === "active") {
    // Already active — treat as idempotent success.
    return { meeting, path: found.path, previousState: "active" };
  }

  meeting.status = "active";
  meeting.started_at = isoTimestamp(deps);
  meeting.picked_up_by = opts.pickedUpBy ?? deps.env().OPENCLAW_AGENT_ID ?? "unknown";

  // Write the updated content into the pending location first, then
  // move it to active/. Two writes look wasteful but keep the file
  // content + location consistent even if the move fails.
  writeMeeting(found.path, meeting);
  const newPath = moveMeeting(deps, meeting.meeting_id, found.path, "active");
  return { meeting, path: newPath, previousState: "pending" };
}

export interface SendOptions {
  meeting: string;
  message: string;
  from?: string;
  fromIcon?: string;
  toIcon?: string;
  /** Skip visible frame wrapping (useful for bootstrap messages). */
  raw?: boolean;
}

export interface SendResult {
  meeting: MeetingFile;
  path: string;
  deliveredText: string;
  replyText: string;
}

/**
 * Send a turn in an active meeting. Wraps the body in a speaker-turn
 * frame and invokes `openclaw agent --to <chat> --channel <channel>
 * --deliver --message <framed>` so the target agent runs one turn and
 * posts both sides back to the channel. Updates the meeting file with
 * the new turn in the transcript + bumps the turn counter.
 *
 * The meeting must be in `active` state. If it's still `pending`,
 * pickup is required first.
 */
export async function sendTurn(deps: MeetDeps, opts: SendOptions): Promise<SendResult> {
  const found = findMeetingFile(deps, opts.meeting);
  if (!found) {
    throw new Error(`meet send: meeting not found: ${opts.meeting}`);
  }
  if (found.state !== "active") {
    throw new Error(
      `meet send: meeting ${opts.meeting} is ${found.state}, not active; ` +
        `pick it up first with \`openclaw meet pickup --meeting ${opts.meeting}\``,
    );
  }

  const meeting = readMeeting(found.path);
  const fromAgent = opts.from ?? meeting.picked_up_by ?? "claude-code";
  const fromIcon = opts.fromIcon ?? "🤖";
  const toIcon = opts.toIcon ?? "🦾";
  // Who the message is addressed to depends on who's speaking. If the
  // sender matches the meeting's dialer (`from_agent`), they're
  // talking to the target (`to_agent`). If the sender is the picker-up
  // or the target, they're talking back to the dialer. This lets the
  // same `meet send` verb handle both directions of a 1:1 meeting
  // without callers having to compute the recipient manually.
  const listenerAgent = fromAgent === meeting.from_agent ? meeting.to_agent : meeting.from_agent;

  // Parse reply_via (e.g., "telegram:5727573728") into channel + chat.
  const [channel, chatId] = (meeting.reply_via ?? "").split(":");
  if (!channel || !chatId) {
    throw new Error(
      `meet send: meeting ${opts.meeting} has no usable reply_via: ` +
        `"${meeting.reply_via}". Cannot route turn.`,
    );
  }

  const framedMessage = opts.raw
    ? opts.message
    : speakerFrame(fromAgent, listenerAgent, opts.message, fromIcon, toIcon);

  const args = [
    "agent",
    "--to",
    chatId,
    "--channel",
    channel,
    "--deliver",
    "--json",
    "--timeout",
    "180",
    "--message",
    framedMessage,
  ];

  const { stdout } = await deps.runAgentTurn(args);

  // Parse the agent response. `openclaw agent --json` returns a fairly
  // deep object; the assistant's visible reply is at
  // result.meta.finalAssistantVisibleText in current shape. Fall back
  // to the first payload text if that's missing.
  let replyText = "";
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    replyText = extractReplyText(parsed) ?? "";
  } catch {
    // Non-JSON output — capture raw stdout as the reply so we still
    // record something in the transcript.
    replyText = stdout.slice(0, 4000);
  }

  // Append to transcript + bump turn counter.
  const turn: MeetingTurn = {
    ts: isoTimestamp(deps),
    from: fromAgent,
    to: listenerAgent,
    body: opts.message,
    ...(replyText ? { reply: replyText } : {}),
  };
  meeting.transcript = [...(meeting.transcript ?? []), turn];
  meeting.turns = (meeting.turns ?? 0) + 1;
  writeMeeting(found.path, meeting);

  return {
    meeting,
    path: found.path,
    deliveredText: framedMessage,
    replyText,
  };
}

/**
 * Walk a parsed agent-response object and return the first string
 * value at any of the canonical "visible reply" paths. Defensive
 * because the shape has drifted a few times.
 */
function extractReplyText(root: unknown): string | undefined {
  const candidates: string[] = ["finalAssistantVisibleText"];
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }
    for (const key of candidates) {
      const val = (current as Record<string, unknown>)[key];
      if (typeof val === "string") {
        return val;
      }
    }
    for (const val of Object.values(current as Record<string, unknown>)) {
      if (val && typeof val === "object") {
        queue.push(val);
      }
    }
  }
  return undefined;
}

export interface WrapOptions {
  meeting: string;
  outcome?: string;
  /** If true, do not post a wrap frame to the channel — only move the
   *  file. Useful for silent test cleanup. */
  silent?: boolean;
}

export interface WrapResult {
  meeting: MeetingFile;
  path: string;
}

/**
 * Terminal transition: move active → closed, record ended_at +
 * outcome, optionally post the wrap frame to the channel. Throws if
 * the meeting is not currently active.
 */
export async function wrapMeeting(deps: MeetDeps, opts: WrapOptions): Promise<WrapResult> {
  const found = findMeetingFile(deps, opts.meeting);
  if (!found) {
    throw new Error(`meet wrap: meeting not found: ${opts.meeting}`);
  }
  if (found.state !== "active") {
    throw new Error(`meet wrap: meeting ${opts.meeting} is ${found.state}, not active`);
  }

  const meeting = readMeeting(found.path);
  meeting.status = "closed";
  meeting.ended_at = isoTimestamp(deps);
  if (opts.outcome !== undefined) {
    meeting.outcome = opts.outcome;
  }

  writeMeeting(found.path, meeting);

  if (!opts.silent) {
    const [channel, chatId] = (meeting.reply_via ?? "").split(":");
    if (channel && chatId) {
      try {
        await deps.runAgentTurn([
          "message",
          "send",
          "--channel",
          channel,
          "--target",
          chatId,
          "--message",
          wrapFrame(meeting),
        ]);
      } catch {
        // Best-effort wrap post. If the channel is temporarily down
        // the file is still moved to closed so future tooling can see
        // it; the wrap frame is a visibility convenience, not the
        // source of truth.
      }
    }
  }

  const newPath = moveMeeting(deps, meeting.meeting_id, found.path, "closed");
  return { meeting, path: newPath };
}

export interface ListOptions {
  state?: MeetingStatus | "all";
  to?: string;
}

export function listMeetings(deps: MeetDeps, opts: ListOptions = {}): MeetingFile[] {
  ensureDirs(deps);
  // Default to pending — the common case is "what do I need to pick up?"
  // Pass `state: "all"` to see everything.
  const requested = opts.state ?? "pending";
  const states: MeetingStatus[] =
    requested === "all" ? ["pending", "active", "closed"] : [requested];

  const out: MeetingFile[] = [];
  for (const state of states) {
    const dir = dirForState(deps, state);
    if (!existsSync(dir)) {
      continue;
    }
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      try {
        const m = readMeeting(pathJoin(dir, entry));
        if (opts.to && m.to_agent !== opts.to) {
          continue;
        }
        out.push(m);
      } catch {
        // Skip unparsable files — doesn't fail the listing.
      }
    }
  }
  // Oldest first; callers (list / transcript) prefer chronological.
  return out.toSorted((a, b) => a.created_at.localeCompare(b.created_at));
}

export function showMeeting(deps: MeetDeps, meetingId: string): MeetingFile {
  const found = findMeetingFile(deps, meetingId);
  if (!found) {
    throw new Error(`meet show: meeting not found: ${meetingId}`);
  }
  return readMeeting(found.path);
}

/**
 * Render a human-readable transcript. Uses the visual frames so the
 * terminal output matches what was posted to the channel during the
 * live meeting.
 */
export function renderTranscript(meeting: MeetingFile): string {
  const initiatorIcon = "🤖";
  const targetIcon = "🦾";
  const lines: string[] = [openFrame(meeting, initiatorIcon, targetIcon), ""];
  if (meeting.context.trim()) {
    lines.push(`*Context:* ${meeting.context}`, "");
  }
  for (const turn of meeting.transcript ?? []) {
    lines.push(speakerFrame(turn.from, turn.to, turn.body, initiatorIcon, targetIcon));
    if (turn.reply) {
      lines.push("", speakerFrame(turn.to, turn.from, turn.reply, targetIcon, initiatorIcon));
    }
    lines.push("");
  }
  if (meeting.status === "closed") {
    lines.push(wrapFrame(meeting));
  } else {
    lines.push(`*(meeting still ${meeting.status})*`);
  }
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Public re-exports for the CLI wiring module
// ──────────────────────────────────────────────────────────────────────────

export const _internal = {
  meetingsRoot,
  findMeetingFile,
  generateMeetingId,
  openFrame,
  speakerFrame,
  wrapFrame,
};
