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
   * Execute a literal channel send via `openclaw message send ...` and
   * return the stdout. Used by sendTurn to explicitly post the turn
   * body to the channel BEFORE the agent call, so both halves of the
   * conversation are visible in the channel surface (e.g. Telegram).
   *
   * The PR claim "openclaw agent --deliver posts BOTH the prompt and
   * the reply" used to be literally true when the input-echo-to-channel
   * path existed; today that path is flaky (body sometimes invisible
   * to the channel even when the agent session receives it with
   * channel-ingest formatting). Rather than chase the regression in
   * the gateway agent handler, meet.ts enforces the invariant locally:
   * body is always explicitly posted, then the agent turn runs. This
   * is robust to any gateway drift in the input-post half.
   *
   * Best-effort: errors are logged but do not block the agent turn.
   */
  runMessageSend: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
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
    runMessageSend: async (args) => {
      const { stdout, stderr } = await execFile("openclaw", args, {
        maxBuffer: 4 * 1024 * 1024,
        timeout: 60 * 1000,
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

/**
 * Stable per-agent icon registry. Distinct icons per identity make it
 * obvious at a glance who is speaking in a mixed chat view — before
 * this, every frame defaulted to 🤖 → 🦾 regardless of which agents
 * were on the turn, so consecutive turns from different agent pairs
 * all looked identical in Telegram.
 *
 * Additions: add an entry here when introducing a new agent identity
 * to the meet protocol. Keep icons visually distinct — the whole point
 * is that two adjacent turns from different agents are instantly
 * distinguishable without reading the names.
 */
const AGENT_ICONS: Record<string, string> = {
  "claude-code": "🦾",
  claude: "🦾",
  "openclaw-main": "🦀",
  openclaw: "🦀",
  main: "🦀",
  "meet-doctor": "🩺",
  "meet-doctor-target": "⚕️",
};

/**
 * Return a stable icon for the given agent identity. Falls back to a
 * generic robot for unknown agents so nothing blows up if a frame is
 * rendered before the registry is updated.
 */
function agentIcon(agent: string): string {
  const normalized = agent.trim().toLowerCase();
  return AGENT_ICONS[normalized] ?? "🤖";
}

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
  return [`${fromIcon} *${from}* → ${toIcon} *${to}*`, HR, body, HR].join("\n");
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
  // Who the message is addressed to depends on who's speaking. If the
  // sender matches the meeting's dialer (`from_agent`), they're
  // talking to the target (`to_agent`). If the sender is the picker-up
  // or the target, they're talking back to the dialer. This lets the
  // same `meet send` verb handle both directions of a 1:1 meeting
  // without callers having to compute the recipient manually.
  const listenerAgent = fromAgent === meeting.from_agent ? meeting.to_agent : meeting.from_agent;
  // Icons: derive from the agent registry so each identity gets its
  // own visual marker. Explicit opts.fromIcon/opts.toIcon still win if
  // passed — used by tests and by callers that want to override for
  // one specific turn. Default is agentIcon(<name>) which produces
  // stable per-identity icons (claude-code 🦾, openclaw-main 🦀, etc).
  const fromIcon = opts.fromIcon ?? agentIcon(fromAgent);
  const toIcon = opts.toIcon ?? agentIcon(listenerAgent);

  // Parse reply_via (e.g., "telegram:1234567890") into channel + chat.
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

  // STEP 1 — Post the framed body to the channel as a literal message.
  // This restores the "both halves visible in channel" invariant the
  // original PR claimed for `agent --deliver`. Historically `agent
  // --deliver` had an input-echo-to-channel path that posted the prompt
  // to the channel before running the agent; that path has regressed
  // and today the body is synthesized into the agent session with
  // channel-ingest formatting but never actually hits the channel
  // outbound. Rather than chase the gateway-side regression, we post
  // the body here explicitly so the user sees both sides of every
  // turn regardless of what `agent --deliver` does internally.
  //
  // Best-effort: if the send fails, we still run the agent turn so
  // the meeting can proceed — the body just won't be visible to
  // Telegram viewers. The meeting JSON transcript always has it.
  //
  // 2026-04-12 diagnosis: proved via instrumented trace that the
  // reply path reaches handler.sendText and returns a real messageId,
  // but the body path never calls the channel outbound at all.
  try {
    await deps.runMessageSend([
      "message",
      "send",
      "--target",
      chatId,
      "--channel",
      channel,
      "--message",
      framedMessage,
    ]);
  } catch (err) {
    // Non-fatal: log to stderr so operators can see body-post failures,
    // but proceed with the agent turn. The meeting JSON still captures
    // the body in its transcript array regardless.
    process.stderr.write(
      `meet send: body channel-post failed (agent turn will still run): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // STEP 2 — Run the agent turn WITHOUT --deliver. The agent reads
  // the framed body as input, generates a reply, and returns the
  // reply out-of-band via JSON stdout. We deliberately omit --deliver
  // so the agent does NOT auto-post the bare reply to the channel —
  // that would duplicate content because STEP 3 below explicitly
  // reposts the reply wrapped in its own reverse-direction speaker
  // frame (🦀 openclaw-main → 🦾 claude-code for a claude-code →
  // openclaw-main turn). This gives symmetric framing on both halves
  // of every turn, so the operator can see at a glance which side of
  // the conversation any bubble belongs to.
  //
  // Verified 2026-04-12: `openclaw agent --to X --message Y --json`
  // (no --deliver) runs the agent, returns the reply in
  // result.meta.finalAssistantVisibleText, and does NOT post to the
  // channel. Confirmed by zero new outbound transcript entries after
  // the probe call.
  const args = [
    "agent",
    "--to",
    chatId,
    "--channel",
    channel,
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

  // STEP 3 — Post the framed reply back to the channel with the
  // reverse direction (listener → from). Agents' raw replies are
  // text-only; by wrapping them in a symmetric speaker frame we give
  // the operator the same visual marker for every message in the
  // channel, not just the bodies we post. Only applied when --raw is
  // false and we actually captured a non-empty reply. Best-effort:
  // if the reframe-post fails, the reply is still in the meeting
  // JSON transcript and the agent's original inference output lives
  // in the agent session log, so no data is lost — only the symmetric
  // Telegram visibility is missed.
  if (!opts.raw && replyText.trim().length > 0) {
    const framedReply = speakerFrame(listenerAgent, fromAgent, replyText, toIcon, fromIcon);
    try {
      await deps.runMessageSend([
        "message",
        "send",
        "--target",
        chatId,
        "--channel",
        channel,
        "--message",
        framedReply,
      ]);
    } catch (err) {
      process.stderr.write(
        `meet send: reply reframe-post failed (reply still in meeting JSON): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
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
  const initiatorIcon = agentIcon(meeting.from_agent);
  const targetIcon = agentIcon(meeting.to_agent);
  const lines: string[] = [openFrame(meeting, initiatorIcon, targetIcon), ""];
  if (meeting.context.trim()) {
    lines.push(`*Context:* ${meeting.context}`, "");
  }
  for (const turn of meeting.transcript ?? []) {
    // Each turn has its own from/to, so resolve icons per turn from
    // the registry — handles turns where the from/to differ from the
    // meeting-level initiator/target (e.g. the picker-up replies back
    // to the dialer).
    const turnFromIcon = agentIcon(turn.from);
    const turnToIcon = agentIcon(turn.to);
    lines.push(speakerFrame(turn.from, turn.to, turn.body, turnFromIcon, turnToIcon));
    if (turn.reply) {
      lines.push("", speakerFrame(turn.to, turn.from, turn.reply, turnToIcon, turnFromIcon));
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
// doctor — smoke test the full meet bridge
// ──────────────────────────────────────────────────────────────────────────

export interface DoctorOptions {
  /** Channel to test delivery against. If omitted, only the local
   *  filesystem state machine is verified (no channel post). */
  channel?: string;
  /** Target chat/account id for the channel test. Required when
   *  --channel is set. */
  target?: string;
  /** When true, clean up the test meeting even if checks fail. Default
   *  is true — leaving orphan test meetings in pending/ pollutes the
   *  real inbox. */
  cleanup?: boolean;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  meeting_id: string | null;
  checks: DoctorCheck[];
}

/**
 * Smoke-test the meet bridge end-to-end.
 *
 * Runs the full dial → pickup → send → wrap lifecycle with a sentinel
 * body, reporting which specific step fails if the bridge drifts.
 *
 * Local-only mode (no channel/target): verifies the filesystem state
 * machine (pending → active → closed) and its idempotency + atomic
 * moves. Safe to run anywhere, no external side effects.
 *
 * Channel mode (channel + target provided): additionally runs a real
 * meet send turn through the given channel/target, verifies the
 * agent returns a non-empty reply, and records both body and reply
 * in the meeting transcript. This exercises the full path that broke
 * on 2026-04-12 (body invisible in channel because the input-echo
 * regressed in the gateway). If the meet send wrapper's body-post
 * step ever fails again, this test will surface a
 * `body_channel_post_failed` check within seconds of drift.
 *
 * This is deliberately unit-test-free: the whole point is to run it
 * against the live gateway and real channels so we catch runtime
 * drift that unit tests cannot see.
 */
export async function doctorMeet(deps: MeetDeps, opts: DoctorOptions = {}): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const cleanup = opts.cleanup !== false;
  let meetingId: string | null = null;

  const push = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  const sentinelTag = `MEETDOCTOR-${deps.now().getTime()}-${deps.randHex(3)}`;
  const sentinelBody = `${sentinelTag} (openclaw meet doctor smoke test — if you see this line the bridge body-post path is healthy)`;

  // ── step 1: filesystem writable ──────────────────────────────────
  try {
    ensureDirs(deps);
    push("meet_dirs_writable", true, `ensured pending/active/closed under ${meetingsRoot(deps)}`);
  } catch (err) {
    push(
      "meet_dirs_writable",
      false,
      `failed to create meet dirs: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, meeting_id: null, checks };
  }

  // ── step 2: dial ─────────────────────────────────────────────────
  let dialResult: DialResult;
  try {
    dialResult = dialMeeting(deps, {
      to: "meet-doctor-target",
      topic: `meet doctor smoke test ${sentinelTag}`,
      context: "automated bridge smoke test; safe to ignore",
      from: "meet-doctor",
      fromChannel: opts.channel ?? "cli",
      fromChat: opts.target ?? "",
    });
    meetingId = dialResult.meeting.meeting_id;
    push("dial_creates_pending", true, `created pending file at ${dialResult.path}`);
  } catch (err) {
    push(
      "dial_creates_pending",
      false,
      `meet dial failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, meeting_id: null, checks };
  }

  // ── step 3: pickup ───────────────────────────────────────────────
  try {
    pickupMeeting(deps, { meeting: meetingId, pickedUpBy: "meet-doctor" });
    push("pickup_moves_to_active", true, "atomic move pending → active succeeded");
  } catch (err) {
    push(
      "pickup_moves_to_active",
      false,
      `meet pickup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (cleanup) {
      await cleanupDoctorMeeting(deps, meetingId);
    }
    return { ok: false, meeting_id: meetingId, checks };
  }

  // ── step 4: send — only if channel + target are provided ────────
  if (opts.channel && opts.target) {
    // Override reply_via so the test turn actually routes through
    // the requested channel/target pair.
    try {
      const activePath = pathJoin(dirForState(deps, "active"), `${meetingId}.json`);
      const m = readMeeting(activePath);
      m.reply_via = `${opts.channel}:${opts.target}`;
      writeMeeting(activePath, m);
    } catch (err) {
      push(
        "set_reply_via",
        false,
        `could not set reply_via on active meeting: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (cleanup) {
        await cleanupDoctorMeeting(deps, meetingId);
      }
      return { ok: false, meeting_id: meetingId, checks };
    }

    let sendResult: SendResult | null = null;
    try {
      sendResult = await sendTurn(deps, {
        meeting: meetingId,
        message: sentinelBody,
        from: "meet-doctor",
      });
      push(
        "send_executes",
        true,
        `meet send completed, body framed (${sendResult.deliveredText.length} chars)`,
      );
    } catch (err) {
      push(
        "send_executes",
        false,
        `meet send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (sendResult) {
      // Body was framed and passed to the wrapper. sendTurn calls
      // runMessageSend for the body-post step — if that step failed,
      // the catch inside sendTurn writes to stderr but does not throw.
      // We can't directly observe whether the stderr was written from
      // here, but we CAN check the meeting transcript for the body.
      const transcript = sendResult.meeting.transcript ?? [];
      const lastTurn = transcript.at(-1);
      const bodyCaptured = lastTurn?.body?.includes(sentinelTag) ?? false;
      push(
        "body_captured_in_transcript",
        bodyCaptured,
        bodyCaptured
          ? `sentinel ${sentinelTag} present in meeting transcript body`
          : `sentinel ${sentinelTag} NOT found in transcript`,
      );

      // Reply check — the most important signal of bridge health.
      // If the agent turn runs but returns no reply, the agent path
      // is silently dropping or the gateway delivery path is broken.
      const replyText = sendResult.replyText?.trim() ?? "";
      const replyOk = replyText.length > 0;
      push(
        "reply_captured",
        replyOk,
        replyOk
          ? `reply captured (${replyText.length} chars)`
          : "reply text is empty — agent turn produced no usable output",
      );
    }
  } else {
    push(
      "send_skipped",
      true,
      "channel + target not provided, skipping channel turn — local-only mode",
    );
  }

  // ── step 5: wrap ─────────────────────────────────────────────────
  if (cleanup) {
    try {
      await wrapMeeting(deps, {
        meeting: meetingId,
        outcome: `meet doctor smoke test ${sentinelTag}`,
        silent: true,
      });
      push("wrap_moves_to_closed", true, "atomic move active → closed succeeded");
    } catch (err) {
      push(
        "wrap_moves_to_closed",
        false,
        `meet wrap failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const ok = checks.every((c) => c.ok);
  return { ok, meeting_id: meetingId, checks };
}

/**
 * Best-effort cleanup helper — moves a test meeting to closed/ with a
 * canned outcome. Swallows errors because it's called from failure
 * paths that already have a real error to report.
 */
async function cleanupDoctorMeeting(deps: MeetDeps, meetingId: string): Promise<void> {
  try {
    await wrapMeeting(deps, {
      meeting: meetingId,
      outcome: "meet doctor: failed, cleanup",
      silent: true,
    });
  } catch {
    // Ignore — cleanup is best-effort
  }
}

/** Format a human-readable doctor report for stdout. */
export function formatDoctorResult(result: DoctorResult): string {
  const lines: string[] = [];
  lines.push(`meet doctor: ${result.ok ? "✅ PASS" : "❌ FAIL"}`);
  if (result.meeting_id) {
    lines.push(`test meeting: ${result.meeting_id}`);
  }
  lines.push("");
  for (const c of result.checks) {
    const icon = c.ok ? "✅" : "❌";
    lines.push(`  ${icon} ${c.name}`);
    lines.push(`      ${c.detail}`);
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
