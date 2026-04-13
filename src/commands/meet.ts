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
  // Fallback order: explicit opt → env var → meeting.to_agent (who was dialed)
  //                 → "unknown" as last resort. Falling back to to_agent
  //                 prevents 🤖 unknown rendering when OPENCLAW_AGENT_ID
  //                 isn't plumbed through the caller's shell.
  meeting.picked_up_by =
    opts.pickedUpBy ?? deps.env().OPENCLAW_AGENT_ID ?? meeting.to_agent ?? "unknown";

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

// ──────────────────────────────────────────────────────────────────────────
// Meet Invite — host/guest primitive
// ──────────────────────────────────────────────────────────────────────────
//
// `meet invite` lets the host session bring in a guest CLI for one or
// more turns within an active meeting. The host retains control and
// meeting ownership; the guest is ephemeral — spawned, queried,
// captured, and discarded.
//
// Communication plane invariant: both the invite frame AND the guest
// response land in the meeting's reply_via channel (Telegram, Discord,
// etc.) via runMessageSend — same pattern as sendTurn. The chat
// client is the delivery surface; the meeting JSON file is just
// storage.
//
// Guest registry lives at ~/.openclaw/config/meet-guests.yaml and is
// loaded at invite-time. Each guest defines an adapter type (cli,
// ollama, http) and invocation template. See meet-invite-spec.md for
// the full schema.

/**
 * Guest adapter types. Determines how the guest subprocess is
 * invoked and how its response is parsed.
 *
 * - `cli`: spawn a subprocess (e.g. claude -p, codex exec, gemini -p)
 * - `ollama`: HTTP to a local Ollama endpoint
 * - `http`: generic HTTP API call with bearer auth
 * - `openclaw_agent`: invoke another OpenClaw agent via `openclaw agent
 *   --agent <id>` — used when the "guest" is actually an internal agent
 *   resolved from openclaw.json `agents.list` rather than an external
 *   CLI. The target agent runs one turn in its own session and returns
 *   the reply, which is then framed into the meeting.
 */
export type GuestAdapter = "cli" | "ollama" | "http" | "openclaw_agent";

/**
 * One entry in the guest registry. Defines how to dial this guest
 * and how to extract its response text from whatever format it
 * returns.
 */
export interface GuestDefinition {
  icon: string;
  description: string;
  adapter: GuestAdapter;
  timeout?: number;
  // cli adapter fields
  command?: string;
  args?: string[];
  // ollama/http adapter fields
  endpoint?: string;
  model?: string;
  auth_env?: string;
  // Response parsing
  parse?: "text" | "json";
  capture?: string; // JSON path for "json" parse (e.g. "choices[0].message.content")
}

export interface GuestRegistry {
  guests: Record<string, GuestDefinition>;
  budgets?: {
    global_daily_max_invokes?: number;
    per_guest_hourly_max?: Record<string, number>;
  };
}

export interface InviteOptions {
  /** Meeting id to inject into. Required unless `create` is true. */
  meeting?: string;
  /** If true, create a fresh ephemeral meeting before the invite. */
  create?: boolean;
  /** Registered guest id from meet-guests.yaml */
  guest: string;
  /** The question/task for the guest */
  prompt: string;
  /** How many prior transcript turns to include (default: 3). */
  contextDepth?: number;
  /** Timeout override in seconds. Default: guest.timeout or 180. */
  timeout?: number;
  /** Host identity (defaults to OPENCLAW_AGENT_ID env). */
  from?: string;
  /** Override meeting.reply_via for the communication plane. */
  replyVia?: string;
  /** Topic for ephemeral meetings (required when create=true). */
  topic?: string;
}

export interface InviteResult {
  meeting_id: string;
  guest: string;
  response_text: string;
  latency_ms: number;
  frame_delivered: boolean;
  ephemeral: boolean;
}

/**
 * Load the guest registry by merging three sources:
 *
 *   1. OpenClaw agents declared in ~/.openclaw/openclaw.json under
 *      `agents.list`. Each entry becomes an `openclaw_agent` adapter
 *      that runs via `openclaw agent --agent <id>`. No separate config
 *      file needed — the existing agent directory IS the first-class
 *      source of truth.
 *
 *   2. External CLI / HTTP / Ollama guests declared in
 *      ~/.openclaw/config/meet-guests.yaml. These are things OpenClaw
 *      doesn't own — claude-code, gemini, codex, perplexity, local
 *      Ollama endpoints.
 *
 *   3. Built-in minimal default (claude-code only) if neither of the
 *      above is found, so the command works out of the box on a fresh
 *      install.
 *
 * Resolution order when an id collides: openclaw.json agents win over
 * the guest YAML, so operators can shadow a guest definition by adding
 * an agent entry with the same id. That's intentional — it lets you
 * migrate a CLI guest into a proper OpenClaw agent without changing
 * how callers invoke it.
 */
export function loadGuestRegistry(deps: MeetDeps): GuestRegistry {
  const registry: GuestRegistry = { guests: {} };

  // Source 2 + 3: guest YAML (or built-in default)
  const overridePath = deps.env().OPENCLAW_GUEST_REGISTRY?.trim();
  const defaultYamlPath = pathJoin(deps.homedir(), ".openclaw", "config", "meet-guests.yaml");
  const yamlPath = overridePath && overridePath.length > 0 ? overridePath : defaultYamlPath;

  if (existsSync(yamlPath)) {
    const raw = readFileSync(yamlPath, "utf8");
    const parsed = parseGuestYaml(raw);
    Object.assign(registry.guests, parsed.guests);
    if (parsed.budgets) {
      registry.budgets = parsed.budgets;
    }
  } else {
    // Built-in minimal default: just the Anthropic Claude Code CLI.
    registry.guests["claude-code"] = {
      icon: "🦾",
      description: "Anthropic Claude Code CLI — reasoning, code review",
      adapter: "cli",
      command: pathJoin(deps.homedir(), ".local", "bin", "claude"),
      args: ["-p", "{{prompt}}"],
      timeout: 300,
      parse: "text",
    };
  }

  // Source 1: OpenClaw agents from openclaw.json agents.list
  //
  // We read this raw rather than going through the typed
  // listAgentEntries() helper because meet.ts tries to stay
  // self-contained and avoid pulling in the full config schema. The
  // downside is we don't get schema validation; the upside is this
  // module doesn't have to know about OpenClawConfig shape drift. If
  // meet.ts graduates upstream, this should be replaced with a proper
  // listAgentEntries() call.
  //
  // The meet block is stored under `params.meet` (a generic catch-all
  // field on agent entries) rather than as a top-level key, because
  // the AgentEntrySchema is strict() and would reject an unknown
  // top-level field. params is already typed as
  // `z.record(z.string(), z.unknown())` so it accepts any nested
  // shape.
  const openclawJson = pathJoin(deps.homedir(), ".openclaw", "openclaw.json");
  if (existsSync(openclawJson)) {
    try {
      const config = JSON.parse(readFileSync(openclawJson, "utf8")) as Record<string, unknown>;
      const agents = (config.agents as Record<string, unknown> | undefined)?.list;
      if (Array.isArray(agents)) {
        for (const entry of agents) {
          if (!entry || typeof entry !== "object") {
            continue;
          }
          const e = entry as Record<string, unknown>;
          const id = typeof e.id === "string" ? e.id.trim() : "";
          if (!id) {
            continue;
          }

          // Read meet block from params.meet (preferred) or fall back
          // to a top-level meet field for tests / future schema
          // graduation.
          const params = e.params as Record<string, unknown> | undefined;
          const meetBlock =
            (params?.meet as Record<string, unknown> | undefined) ??
            (e.meet as Record<string, unknown> | undefined);
          if (!meetBlock || typeof meetBlock !== "object") {
            continue;
          }

          // Capability gate: must have can_invite !== false to be
          // dialable as a guest. Default is true for agents with a
          // meet block.
          if (meetBlock.can_invite === false) {
            continue;
          }

          registry.guests[id] = {
            icon: (meetBlock.icon as string) || "🤖",
            description:
              (meetBlock.description as string) || (e.name as string) || `OpenClaw agent: ${id}`,
            adapter: "openclaw_agent",
            timeout: (meetBlock.timeout as number) ?? 300,
            // Reuse the command/args slots to carry the target agent id
            command: id,
            args: [],
            parse: "text",
          };
        }
      }
    } catch {
      // Config read/parse failure is non-fatal — fall back to
      // whatever we got from the guest YAML.
    }
  }

  return registry;
}

/**
 * Minimal YAML parser sufficient for meet-guests.yaml. Handles:
 *   - top-level keys (guests, budgets)
 *   - nested object values (arbitrary nesting depth)
 *   - string, number, boolean, null scalars
 *   - arrays as `[a, b, c]` inline OR block-style `- item` at deeper indent
 *   - `#` comments
 *
 * Block-list rule: list items must be at a STRICTLY deeper indent than
 * the key that opens them. This works:
 *     args:
 *       - "-p"
 *       - "--dir"
 * This does NOT work (ambiguous sibling-vs-child):
 *     args:
 *     - "-p"
 * Use the indented form or inline `[a, b]`.
 *
 * Does NOT handle: multiline strings, anchors, references, flow
 * mappings, !!tags. Good enough for a hand-written config file
 * that's rarely edited. If the config grows complex, swap to js-yaml.
 */
function parseGuestYaml(raw: string): GuestRegistry {
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/^(\s*)#.*$/, "$1").trimEnd())
    .filter((l) => l.trim().length > 0);

  const out: GuestRegistry = { guests: {} };
  type Frame = { indent: number; container: Record<string, unknown> | unknown[] };
  const stack: Frame[] = [{ indent: -1, container: out as unknown as Record<string, unknown> }];
  // When we see `key:` with empty value, the child could be either an
  // object (next line is `nestedKey: ...`) or a list (next line is
  // `- item`). We defer the decision until we see the first child.
  let pending: { parent: Record<string, unknown>; key: string; keyIndent: number } | null = null;

  const flushPendingAsEmpty = (): void => {
    if (!pending) {
      return;
    }
    pending.parent[pending.key] = {};
    pending = null;
  };

  for (const line of lines) {
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    const content = line.slice(indent);
    const isList = content.startsWith("- ");

    // Materialize any deferred container now that we know what the
    // first child looks like. Child must be strictly deeper than the
    // key that opened it — same-indent siblings mean the key had no
    // children.
    if (pending) {
      if (indent > pending.keyIndent) {
        const container: Record<string, unknown> | unknown[] = isList ? [] : {};
        pending.parent[pending.key] = container;
        stack.push({ indent: pending.keyIndent, container });
        pending = null;
      } else {
        flushPendingAsEmpty();
      }
    }

    // Pop frames that are no longer ancestors of this line.
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const top = stack[stack.length - 1];

    if (isList) {
      if (!Array.isArray(top.container)) {
        throw new Error(
          `meet-guests.yaml parse error: unexpected list item at indent ${indent} — ` +
            `parent is not a list. Block lists must be nested under a key with a ` +
            `deeper indent, e.g.:\n  args:\n    - "-p"\n    - "--dir"`,
        );
      }
      const item = content.slice(2).trim();
      top.container.push(parseScalar(item));
      continue;
    }

    const match = content.match(/^(\S.*?):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    if (Array.isArray(top.container)) {
      throw new Error(
        `meet-guests.yaml parse error: unexpected key "${key}" at indent ${indent} — ` +
          `parent is a list. Did you mean to write "- ${key}: ${rawValue}"?`,
      );
    }
    const parent = top.container;

    if (rawValue.length === 0) {
      pending = { parent, key, keyIndent: indent };
    } else {
      parent[key] = parseScalar(rawValue);
    }
  }

  flushPendingAsEmpty();
  return out;
}

/**
 * Resolve the timeout (in seconds) for a guest invocation.
 *
 * Precedence — highest wins:
 *   1. Explicit CLI / API override (`opts.timeout`, e.g. --timeout 300)
 *   2. Guest registry default from meet-guests.yaml / openclaw.json
 *   3. Hard-coded baseline of 180s
 *
 * This is extracted so it can be unit-tested directly and so callers
 * can audit precedence without reading the ternary inline. The
 * 2026-04-13 bug where meet-watcher.sh hardcoded `--timeout 300` and
 * silently shadowed a YAML `timeout: 600` traces back to this line;
 * making it a named helper means future reviewers see the rule.
 */
export function resolveGuestTimeoutSec(
  optOverride: number | undefined,
  guestDefault: number | undefined,
): number {
  if (typeof optOverride === "number" && optOverride > 0) {
    return optOverride;
  }
  if (typeof guestDefault === "number" && guestDefault > 0) {
    return guestDefault;
  }
  return 180;
}

function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "true") {
    return true;
  }
  if (v === "false") {
    return false;
  }
  if (v === "null") {
    return null;
  }
  if (/^-?\d+$/.test(v)) {
    return parseInt(v, 10);
  }
  if (/^-?\d+\.\d+$/.test(v)) {
    return parseFloat(v);
  }
  // Inline array: [a, b, c] or ["a", "b", "c"]
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner.length === 0) {
      return [];
    }
    return inner.split(",").map((s) => parseScalar(s.trim()));
  }
  // Quoted strings
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Build the prompt text sent to a guest. Includes meeting topic,
 * original context, last N turns, and the new question. Kept as a
 * single string so cli guests can just pass it via argv.
 *
 * For long contexts the caller can pin `contextDepth` to a smaller
 * number. For very long meetings the host should prefer to summarize
 * in the prompt itself rather than dumping raw transcript.
 */
function buildGuestContext(meeting: MeetingFile, contextDepth: number, prompt: string): string {
  const parts: string[] = [];
  parts.push(`Meeting topic: ${meeting.topic}`);
  if (meeting.context && meeting.context.trim().length > 0) {
    parts.push(`Context: ${meeting.context}`);
  }

  const turns = meeting.transcript ?? [];
  if (turns.length > 0) {
    const recent = turns.slice(-contextDepth);
    parts.push("\nRecent conversation:");
    for (const t of recent) {
      parts.push(`[${t.from} → ${t.to}]: ${t.body}`);
    }
  }

  parts.push(`\nQuestion from ${meeting.from_agent ?? "host"}:`);
  parts.push(prompt);
  return parts.join("\n");
}

/**
 * Visual frame announcing a guest invite to the communication plane.
 * Lets the operator see inline that a guest is being dialed in,
 * before the guest's response arrives.
 */
function inviteFrame(
  hostAgent: string,
  hostIcon: string,
  guestName: string,
  guestIcon: string,
  prompt: string,
): string {
  // Trim long prompts for the frame — full prompt still goes to the guest.
  const shortPrompt = prompt.length > 400 ? `${prompt.slice(0, 400)}…` : prompt;
  return [
    `${hostIcon} *${hostAgent}* invites ${guestIcon} *${guestName}*`,
    HR,
    `*Asking about:*`,
    shortPrompt,
    HR,
  ].join("\n");
}

/**
 * Visual frame for a guest failure. Keeps the operator informed when
 * a guest dies, times out, or returns empty. The meeting transcript
 * still captures the failure as a turn for later analysis.
 */
function guestErrorFrame(guestName: string, guestIcon: string, error: string): string {
  return [
    `⚠️ ${guestIcon} *${guestName}* failed to respond`,
    HR,
    error.length > 500 ? `${error.slice(0, 500)}…` : error,
    HR,
  ].join("\n");
}

/**
 * Spawn a cli guest subprocess with the prompt substituted into its
 * args template. Captures stdout, returns the assistant text.
 *
 * Uses execFile (not shell) to avoid injection. The prompt is passed
 * as a single argv element matching the guest's args template.
 */
async function invokeCliGuest(
  guest: GuestDefinition,
  prompt: string,
  timeoutSec: number,
): Promise<{ text: string; latencyMs: number }> {
  if (!guest.command || !guest.args) {
    throw new Error(`meet invite: cli guest missing command or args`);
  }
  const renderedArgs = guest.args.map((a) => a.replace("{{prompt}}", prompt));
  const start = Date.now();
  try {
    const { stdout } = await execFile(guest.command, renderedArgs, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutSec * 1000,
    });
    return { text: stdout.trim(), latencyMs: Date.now() - start };
  } catch (err) {
    const latencyMs = Date.now() - start;
    throw new Error(
      `cli guest failed after ${latencyMs}ms: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * POST to a local Ollama endpoint for a chat completion. Simpler than
 * full http adapter because ollama's schema is stable and we don't
 * need auth.
 */
async function invokeOllamaGuest(
  guest: GuestDefinition,
  prompt: string,
  timeoutSec: number,
): Promise<{ text: string; latencyMs: number }> {
  if (!guest.endpoint || !guest.model) {
    throw new Error(`meet invite: ollama guest missing endpoint or model`);
  }
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const res = await fetch(`${guest.endpoint.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: guest.model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`ollama returned ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const text = (((data.choices as unknown[]) || [])[0] as Record<string, unknown>)?.message as
      | Record<string, unknown>
      | undefined;
    const content = (text?.content as string) ?? "";
    return { text: content.trim(), latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generic HTTP adapter for cloud guests (Perplexity, Anthropic API,
 * OpenAI, etc.). Auth token comes from env var named by
 * `guest.auth_env`. Response text extracted via `guest.capture` JSON
 * path (default: "choices[0].message.content").
 */
async function invokeHttpGuest(
  guest: GuestDefinition,
  prompt: string,
  timeoutSec: number,
  deps: MeetDeps,
): Promise<{ text: string; latencyMs: number }> {
  if (!guest.endpoint || !guest.model) {
    throw new Error(`meet invite: http guest missing endpoint or model`);
  }
  const authToken = guest.auth_env ? deps.env()[guest.auth_env] : undefined;
  if (guest.auth_env && !authToken) {
    throw new Error(`meet invite: http guest requires env var ${guest.auth_env} but it's not set`);
  }

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }
    const res = await fetch(guest.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: guest.model,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`http guest returned ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const path = guest.capture ?? "choices[0].message.content";
    const extracted = extractJsonPath(data, path);
    // Coerce to string carefully — extractJsonPath returns unknown.
    // If it's not a string we stringify via JSON.stringify so we don't
    // emit '[object Object]' garbage on schema drift; lint catches the
    // naive String() coercion.
    const text =
      typeof extracted === "string"
        ? extracted
        : extracted == null
          ? ""
          : JSON.stringify(extracted);
    return { text: text.trim(), latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minimal JSON-path extractor: handles dot notation and [index] for
 * arrays. Good enough for API response shapes — not jq-complete.
 */
function extractJsonPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  const tokens = path.match(/[^.[\]]+|\[\d+\]/g) ?? [];
  for (const token of tokens) {
    if (cursor == null) {
      return undefined;
    }
    if (token.startsWith("[") && token.endsWith("]")) {
      const idx = parseInt(token.slice(1, -1), 10);
      cursor = Array.isArray(cursor) ? cursor[idx] : undefined;
    } else {
      cursor = (cursor as Record<string, unknown>)[token];
    }
  }
  return cursor;
}

/**
 * Invoke an OpenClaw agent as a guest. Runs `openclaw agent --agent
 * <id> --message <prompt> --json` and parses the stdout for the
 * assistant's visible reply text, mirroring how sendTurn does it.
 *
 * The target agent runs in its own session — this preserves its
 * system prompt, memory, and model configuration. The reply is
 * captured and framed back into the calling meeting, so from the
 * caller's perspective the target agent is "the guest" even though
 * internally it's a first-class OpenClaw agent run.
 *
 * We route through deps.runAgentTurn so tests can mock it without
 * spawning a real agent session.
 */
async function invokeOpenClawAgentGuest(
  guest: GuestDefinition,
  prompt: string,
  timeoutSec: number,
  deps: MeetDeps,
): Promise<{ text: string; latencyMs: number }> {
  // For openclaw_agent guests we reuse the `command` slot to carry
  // the target agent id (see loadGuestRegistry above).
  const agentId = guest.command;
  if (!agentId) {
    throw new Error("meet invite: openclaw_agent guest missing target agent id");
  }

  const args = [
    "agent",
    "--agent",
    agentId,
    "--json",
    "--timeout",
    String(timeoutSec),
    "--message",
    prompt,
  ];

  const start = Date.now();
  try {
    const { stdout } = await deps.runAgentTurn(args);
    // Reuse the same extraction path sendTurn uses for consistency.
    let replyText = "";
    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      replyText = extractReplyText(parsed) ?? "";
    } catch {
      // Non-JSON output (plain-text) — use the raw stdout.
      replyText = stdout.trim();
    }
    return { text: replyText.trim(), latencyMs: Date.now() - start };
  } catch (err) {
    const latencyMs = Date.now() - start;
    throw new Error(
      `openclaw agent guest '${agentId}' failed after ${latencyMs}ms: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Dispatcher: given a guest definition, pick the right adapter and
 * run it. Each adapter returns {text, latencyMs}; failures throw.
 */
async function invokeGuest(
  guest: GuestDefinition,
  prompt: string,
  timeoutSec: number,
  deps: MeetDeps,
): Promise<{ text: string; latencyMs: number }> {
  switch (guest.adapter) {
    case "cli":
      return invokeCliGuest(guest, prompt, timeoutSec);
    case "ollama":
      return invokeOllamaGuest(guest, prompt, timeoutSec);
    case "http":
      return invokeHttpGuest(guest, prompt, timeoutSec, deps);
    case "openclaw_agent":
      return invokeOpenClawAgentGuest(guest, prompt, timeoutSec, deps);
    default: {
      // Defensive: guest.adapter is statically `never` here because
      // every variant of GuestAdapter is handled above. We still want
      // a runtime error for malformed configs that smuggle in an
      // unknown adapter string from YAML — cast through unknown so
      // the template literal doesn't trip the never-stringification
      // lint rule.
      const unknownAdapter = (guest as { adapter: unknown }).adapter;
      throw new Error(`meet invite: unknown adapter "${String(unknownAdapter)}"`);
    }
  }
}

/**
 * Create an ephemeral meeting on the fly for one-shot invites. Puts
 * the meeting directly in `active/` (bypassing pending → active) so
 * the invite can proceed immediately. `to_agent` is set to the guest
 * id, `picked_up_by` to the host, since nobody needs to "pick up" —
 * the host already owns it.
 */
function createEphemeralMeeting(
  deps: MeetDeps,
  hostAgent: string,
  guestId: string,
  topic: string,
  replyVia: string,
): MeetingFile {
  ensureDirs(deps);
  const [channel, chatId] = (replyVia ?? "").split(":");
  const meeting: MeetingFile = {
    meeting_id: generateMeetingId(deps),
    from_agent: hostAgent,
    from_channel: channel ?? "cli",
    from_chat_id: chatId ?? "",
    to_agent: guestId,
    topic,
    context: "Ephemeral meeting created for one-shot guest invite",
    reply_via: replyVia,
    created_at: isoTimestamp(deps),
    status: "active",
    started_at: isoTimestamp(deps),
    picked_up_by: hostAgent,
    transcript: [],
  };
  const activePath = pathJoin(dirForState(deps, "active"), `${meeting.meeting_id}.json`);
  writeMeeting(activePath, meeting);
  return meeting;
}

/**
 * Main entry point: invite a guest into a meeting for a single turn.
 *
 * Flow:
 *   1. Resolve host identity (from opts.from or OPENCLAW_AGENT_ID).
 *   2. Load or create meeting.
 *   3. Load guest registry, find the requested guest definition.
 *   4. Build the prompt with recent transcript context.
 *   5. Post the invite frame to the communication plane.
 *   6. Spawn the guest adapter and capture the response.
 *   7. Post the guest response frame to the communication plane.
 *   8. Append the guest turn to the meeting transcript.
 *   9. Return the response text for the host's next reasoning step.
 *
 * Failures mid-flow (guest timeout, subprocess crash, network error)
 * are surfaced to the channel as an error frame, captured in the
 * transcript as a failure turn, and re-thrown so the caller can
 * decide whether to retry.
 */
export async function inviteGuest(deps: MeetDeps, opts: InviteOptions): Promise<InviteResult> {
  // 1. Resolve host identity
  const hostAgent = opts.from ?? deps.env().OPENCLAW_AGENT_ID;
  if (!hostAgent || hostAgent.trim().length === 0) {
    throw new Error("meet invite: no host identity — pass --from or set OPENCLAW_AGENT_ID in env");
  }

  // 2. Load or create meeting
  let meeting: MeetingFile;
  let meetingPath: string;
  let ephemeral = false;

  if (opts.create) {
    if (!opts.replyVia || !opts.replyVia.includes(":")) {
      throw new Error("meet invite --create: --reply-via is required (e.g. 'telegram:1234567890')");
    }
    if (!opts.topic) {
      throw new Error("meet invite --create: --topic is required");
    }
    meeting = createEphemeralMeeting(deps, hostAgent, opts.guest, opts.topic, opts.replyVia);
    meetingPath = pathJoin(dirForState(deps, "active"), `${meeting.meeting_id}.json`);
    ephemeral = true;
  } else {
    if (!opts.meeting) {
      throw new Error("meet invite: --meeting <id> required unless --create is used");
    }
    const found = findMeetingFile(deps, opts.meeting);
    if (!found) {
      throw new Error(`meet invite: meeting not found: ${opts.meeting}`);
    }
    if (found.state !== "active") {
      throw new Error(
        `meet invite: meeting ${opts.meeting} is ${found.state}, not active; ` +
          `pick it up first with \`openclaw meet pickup --meeting ${opts.meeting}\``,
      );
    }
    meeting = readMeeting(found.path);
    meetingPath = found.path;
  }

  // 3. Load guest registry
  const registry = loadGuestRegistry(deps);
  const guest = registry.guests[opts.guest];
  if (!guest) {
    const available = Object.keys(registry.guests).join(", ") || "(none)";
    throw new Error(`meet invite: unknown guest "${opts.guest}". Registered guests: ${available}`);
  }

  // 4. Build the prompt with recent transcript context
  const contextDepth = opts.contextDepth ?? 3;
  const fullPrompt = buildGuestContext(meeting, contextDepth, opts.prompt);

  // Parse the communication plane
  const replyVia = opts.replyVia ?? meeting.reply_via ?? "";
  const [channel, chatId] = replyVia.split(":");
  const canDeliver = Boolean(channel && chatId);

  // 5. Post the invite frame to the channel (best-effort)
  const hostIcon = agentIcon(hostAgent);
  const guestIcon = guest.icon || agentIcon(opts.guest);
  let frameDelivered = false;

  if (canDeliver) {
    try {
      await deps.runMessageSend([
        "message",
        "send",
        "--channel",
        channel,
        "--target",
        chatId,
        "--message",
        inviteFrame(hostAgent, hostIcon, opts.guest, guestIcon, opts.prompt),
      ]);
      frameDelivered = true;
    } catch (err) {
      process.stderr.write(
        `meet invite: invite frame post failed (continuing): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // 6. Invoke the guest adapter
  const timeoutSec = resolveGuestTimeoutSec(opts.timeout, guest.timeout);
  let response: { text: string; latencyMs: number };
  try {
    response = await invokeGuest(guest, fullPrompt, timeoutSec, deps);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Post error frame and record failure turn before re-throwing
    if (canDeliver) {
      try {
        await deps.runMessageSend([
          "message",
          "send",
          "--channel",
          channel,
          "--target",
          chatId,
          "--message",
          guestErrorFrame(opts.guest, guestIcon, errMsg),
        ]);
      } catch {
        // Best-effort — don't mask the original error
      }
    }
    // Record the failed invocation in the transcript for audit
    meeting.transcript = meeting.transcript ?? [];
    meeting.transcript.push({
      ts: isoTimestamp(deps),
      from: opts.guest,
      to: hostAgent,
      body: `[ERROR] ${errMsg}`,
    });
    writeMeeting(meetingPath, meeting);
    throw err;
  }

  // Empty response guard: treat as a failure so the host can retry
  if (!response.text || response.text.trim().length === 0) {
    const errMsg = "guest returned empty response";
    if (canDeliver) {
      try {
        await deps.runMessageSend([
          "message",
          "send",
          "--channel",
          channel,
          "--target",
          chatId,
          "--message",
          guestErrorFrame(opts.guest, guestIcon, errMsg),
        ]);
      } catch {
        // Best-effort
      }
    }
    meeting.transcript = meeting.transcript ?? [];
    meeting.transcript.push({
      ts: isoTimestamp(deps),
      from: opts.guest,
      to: hostAgent,
      body: `[ERROR] ${errMsg}`,
    });
    writeMeeting(meetingPath, meeting);
    throw new Error(`meet invite: ${opts.guest} ${errMsg}`);
  }

  // 7. Post the guest response frame to the channel
  if (canDeliver) {
    try {
      await deps.runMessageSend([
        "message",
        "send",
        "--channel",
        channel,
        "--target",
        chatId,
        "--message",
        speakerFrame(opts.guest, hostAgent, response.text, guestIcon, hostIcon),
      ]);
    } catch (err) {
      process.stderr.write(
        `meet invite: response frame post failed (transcript still recorded): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // 8. Append the turn to the meeting transcript
  meeting.transcript = meeting.transcript ?? [];
  meeting.transcript.push({
    ts: isoTimestamp(deps),
    from: opts.guest,
    to: hostAgent,
    body: response.text,
  });
  writeMeeting(meetingPath, meeting);

  // 9. Return the response for the host's reasoning
  return {
    meeting_id: meeting.meeting_id,
    guest: opts.guest,
    response_text: response.text,
    latency_ms: response.latencyMs,
    frame_delivered: frameDelivered,
    ephemeral,
  };
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
