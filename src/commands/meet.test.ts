// Tests for src/commands/meet.ts — agent teleconference business logic.
//
// Uses a tmp homedir + injected deps so every verb exercises the real
// filesystem lifecycle (pending → active → closed) without touching
// ~/.openclaw/meetings/ on the host running tests.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultMeetDeps,
  dialMeeting,
  listMeetings,
  pickupMeeting,
  renderTranscript,
  sendTurn,
  showMeeting,
  wrapMeeting,
  type MeetDeps,
  type MeetingFile,
} from "./meet.ts";

let tmp: string;
let clock: Date;
let randCounter: number;
let runAgentTurn: ReturnType<typeof vi.fn>;
let runMessageSend: ReturnType<typeof vi.fn>;
let deps: MeetDeps;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "meet-test-"));
  clock = new Date("2026-04-12T14:00:00.000Z");
  randCounter = 0;
  runAgentTurn = vi.fn(async (_args: string[]) => ({
    stdout: JSON.stringify({ result: { meta: { finalAssistantVisibleText: "ok from mock" } } }),
    stderr: "",
  }));
  runMessageSend = vi.fn(async (_args: string[]) => ({
    stdout: "✅ Sent via Telegram. Message ID: test-123\n",
    stderr: "",
  }));
  deps = {
    homedir: () => tmp,
    now: () => new Date(clock.getTime()),
    randHex: () => {
      randCounter += 1;
      // Deterministic 6-char hex for stable meeting_ids in assertions.
      return randCounter.toString(16).padStart(6, "0");
    },
    runAgentTurn,
    runMessageSend,
    env: () => ({}),
  };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function tick(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

// ──────────────────────────────────────────────────────────────────────────
// defaultMeetDeps
// ──────────────────────────────────────────────────────────────────────────

describe("defaultMeetDeps", () => {
  it("wires real homedir, now, random", () => {
    const d = defaultMeetDeps();
    expect(typeof d.homedir()).toBe("string");
    expect(d.now()).toBeInstanceOf(Date);
    expect(typeof d.randHex(3)).toBe("string");
    expect(d.randHex(3)).toHaveLength(6);
    // Do not actually call runAgentTurn in this test — we don't want
    // to spawn a real child process.
    expect(typeof d.runAgentTurn).toBe("function");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// dial
// ──────────────────────────────────────────────────────────────────────────

describe("dialMeeting", () => {
  it("creates a pending-meeting file with all expected fields", () => {
    const { meeting, path: filePath } = dialMeeting(deps, {
      to: "claude-code",
      topic: "remote sentinel polling",
      from: "openclaw-main",
      fromChannel: "telegram",
      fromChat: "1234567890",
    });
    expect(meeting.meeting_id).toMatch(/^mtg_\d+_[0-9a-f]{6}$/);
    expect(meeting.status).toBe("pending");
    expect(meeting.to_agent).toBe("claude-code");
    expect(meeting.topic).toBe("remote sentinel polling");
    expect(meeting.from_agent).toBe("openclaw-main");
    expect(meeting.reply_via).toBe("telegram:1234567890");
    expect(meeting.created_at).toBe("2026-04-12T14:00:00Z");
    expect(filePath).toContain("/meetings/pending/");
    expect(existsSync(filePath)).toBe(true);
    // Verify the on-disk content round-trips.
    const onDisk = JSON.parse(readFileSync(filePath, "utf8")) as MeetingFile;
    expect(onDisk.meeting_id).toBe(meeting.meeting_id);
  });

  it("requires --to and --topic", () => {
    expect(() => dialMeeting(deps, { to: "", topic: "x" })).toThrow(/--to is required/);
    expect(() => dialMeeting(deps, { to: "x", topic: "" })).toThrow(/--topic is required/);
  });

  it("defaults from/channel/chat sensibly when omitted", () => {
    const { meeting } = dialMeeting(deps, { to: "ops", topic: "t" });
    expect(meeting.from_agent).toBe("unknown");
    expect(meeting.from_channel).toBe("cli");
    expect(meeting.from_chat_id).toBe("");
    expect(meeting.reply_via).toBe("");
  });

  it("respects OPENCLAW_AGENT_ID from env for default from", () => {
    deps.env = () => ({ OPENCLAW_AGENT_ID: "axon" });
    const { meeting } = dialMeeting(deps, { to: "claude-code", topic: "t" });
    expect(meeting.from_agent).toBe("axon");
  });

  it("generates distinct meeting_ids across calls", () => {
    const a = dialMeeting(deps, { to: "claude-code", topic: "1" });
    tick(5);
    const b = dialMeeting(deps, { to: "claude-code", topic: "2" });
    expect(a.meeting.meeting_id).not.toBe(b.meeting.meeting_id);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// pickup
// ──────────────────────────────────────────────────────────────────────────

describe("pickupMeeting", () => {
  it("moves pending → active and records started_at + picked_up_by", () => {
    const { meeting: dialed } = dialMeeting(deps, {
      to: "claude-code",
      topic: "t",
      fromChannel: "telegram",
      fromChat: "1234567890",
    });
    tick(1000);
    const result = pickupMeeting(deps, {
      meeting: dialed.meeting_id,
      pickedUpBy: "claude-code-session-1",
    });
    expect(result.previousState).toBe("pending");
    expect(result.meeting.status).toBe("active");
    expect(result.meeting.started_at).toBe("2026-04-12T14:00:01Z");
    expect(result.meeting.picked_up_by).toBe("claude-code-session-1");
    expect(result.path).toContain("/meetings/active/");
    expect(existsSync(result.path)).toBe(true);
    expect(
      existsSync(path.join(tmp, ".openclaw", "meetings", "pending", `${dialed.meeting_id}.json`)),
    ).toBe(false);
  });

  it("is idempotent on already-active meetings", () => {
    const { meeting: dialed } = dialMeeting(deps, {
      to: "claude-code",
      topic: "t",
      fromChannel: "telegram",
      fromChat: "1234567890",
    });
    pickupMeeting(deps, { meeting: dialed.meeting_id });
    const second = pickupMeeting(deps, { meeting: dialed.meeting_id });
    expect(second.previousState).toBe("active");
    expect(second.meeting.status).toBe("active");
  });

  it("throws on closed meetings", async () => {
    const { meeting: dialed } = dialMeeting(deps, {
      to: "claude-code",
      topic: "t",
      fromChannel: "telegram",
      fromChat: "1234567890",
    });
    pickupMeeting(deps, { meeting: dialed.meeting_id });
    await wrapMeeting(deps, { meeting: dialed.meeting_id, silent: true });
    expect(() => pickupMeeting(deps, { meeting: dialed.meeting_id })).toThrow(/already closed/);
  });

  it("throws on unknown meeting ids", () => {
    expect(() => pickupMeeting(deps, { meeting: "mtg_nope" })).toThrow(/not found/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// sendTurn
// ──────────────────────────────────────────────────────────────────────────

describe("sendTurn", () => {
  it("wraps the message in a speaker frame and calls the agent executor", async () => {
    // Dialed FROM openclaw-main TO claude-code. Claude-code picks up
    // and replies back — so the speaker is claude-code, the listener
    // in the frame must be openclaw-main (the dialer), not claude-code.
    const { meeting: dialed } = dialMeeting(deps, {
      from: "openclaw-main",
      to: "claude-code",
      topic: "t",
      fromChannel: "telegram",
      fromChat: "1234567890",
    });
    pickupMeeting(deps, { meeting: dialed.meeting_id, pickedUpBy: "claude-code" });
    const result = await sendTurn(deps, {
      meeting: dialed.meeting_id,
      message: "Hello, one question about X",
    });
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    const args = runAgentTurn.mock.calls[0][0] as string[];
    expect(args[0]).toBe("agent");
    expect(args).toContain("--to");
    expect(args).toContain("1234567890");
    expect(args).toContain("--channel");
    expect(args).toContain("telegram");
    // --deliver is deliberately NOT passed: the agent runs and returns
    // the reply via JSON stdout out-of-band, and meet.ts reposts the
    // reply wrapped in a symmetric reverse-direction speaker frame
    // via message send. If --deliver were passed here, the agent
    // would auto-post the bare reply and we'd get two copies of the
    // reply in the channel (one bare, one framed).
    expect(args).not.toContain("--deliver");
    // Message should be frame-wrapped with the correct direction:
    // picker-up (claude-code) speaking to the dialer (openclaw-main).
    // Per-agent icons: claude-code=🦾, openclaw-main=🦀 (see AGENT_ICONS
    // in meet.ts). Each agent identity has a stable visual marker so
    // adjacent turns from different agents are visually distinct in
    // the channel surface.
    const msgIdx = args.indexOf("--message");
    const framedBody = args[msgIdx + 1];
    expect(framedBody).toContain("🦾 *claude-code*");
    expect(framedBody).toContain("🦀 *openclaw-main*");
    expect(framedBody).toContain("Hello, one question about X");
    // Body and reply each get their own explicit message send call
    // (body via STEP 1, reply reframe via STEP 3). Verify both fired.
    expect(runMessageSend).toHaveBeenCalledTimes(2);
    const bodySendArgs = runMessageSend.mock.calls[0][0] as string[];
    expect(bodySendArgs).toContain("message");
    expect(bodySendArgs).toContain("send");
    const bodyMsgIdx = bodySendArgs.indexOf("--message");
    expect(bodySendArgs[bodyMsgIdx + 1]).toContain("🦾 *claude-code*");
    const replySendArgs = runMessageSend.mock.calls[1][0] as string[];
    const replyMsgIdx = replySendArgs.indexOf("--message");
    // Reply frame has reversed direction: listener → from.
    expect(replySendArgs[replyMsgIdx + 1]).toContain("🦀 *openclaw-main*");
    expect(replySendArgs[replyMsgIdx + 1]).toContain("ok from mock");
    // Reply extracted from mock JSON
    expect(result.replyText).toBe("ok from mock");
    // Transcript bumped, listener correctly set to the dialer
    expect(result.meeting.turns).toBe(1);
    expect(result.meeting.transcript).toHaveLength(1);
    expect(result.meeting.transcript?.[0].from).toBe("claude-code");
    expect(result.meeting.transcript?.[0].to).toBe("openclaw-main");
    expect(result.meeting.transcript?.[0].body).toBe("Hello, one question about X");
    expect(result.meeting.transcript?.[0].reply).toBe("ok from mock");
  });

  it("--raw suppresses frame wrapping", async () => {
    const { meeting: dialed } = dialMeeting(deps, {
      to: "openclaw-main",
      topic: "t",
      fromChannel: "telegram",
      fromChat: "1234567890",
    });
    pickupMeeting(deps, { meeting: dialed.meeting_id });
    await sendTurn(deps, {
      meeting: dialed.meeting_id,
      message: "plain text body",
      raw: true,
    });
    const args = runAgentTurn.mock.calls[0][0] as string[];
    const msgIdx = args.indexOf("--message");
    expect(args[msgIdx + 1]).toBe("plain text body");
  });

  it("throws when meeting is still pending", async () => {
    const { meeting: dialed } = dialMeeting(deps, {
      to: "openclaw-main",
      topic: "t",
      fromChannel: "telegram",
      fromChat: "1234567890",
    });
    await expect(sendTurn(deps, { meeting: dialed.meeting_id, message: "hi" })).rejects.toThrow(
      /pick it up first/,
    );
  });

  it("throws when reply_via is missing", async () => {
    const { meeting: dialed } = dialMeeting(deps, { to: "openclaw-main", topic: "t" });
    pickupMeeting(deps, { meeting: dialed.meeting_id });
    await expect(sendTurn(deps, { meeting: dialed.meeting_id, message: "hi" })).rejects.toThrow(
      /no usable reply_via/,
    );
  });

  it("accumulates transcript across multiple turns", async () => {
    const { meeting: dialed } = dialMeeting(deps, {
      to: "openclaw-main",
      topic: "t",
      fromChannel: "telegram",
      fromChat: "1234567890",
    });
    pickupMeeting(deps, { meeting: dialed.meeting_id });
    await sendTurn(deps, { meeting: dialed.meeting_id, message: "turn 1" });
    tick(5000);
    await sendTurn(deps, { meeting: dialed.meeting_id, message: "turn 2" });
    const shown = showMeeting(deps, dialed.meeting_id);
    expect(shown.turns).toBe(2);
    expect(shown.transcript).toHaveLength(2);
    expect(shown.transcript?.[0].body).toBe("turn 1");
    expect(shown.transcript?.[1].body).toBe("turn 2");
  });

  it("falls back to raw stdout when executor returns non-JSON", async () => {
    const { meeting: dialed } = dialMeeting(deps, {
      to: "openclaw-main",
      topic: "t",
      fromChannel: "telegram",
      fromChat: "1234567890",
    });
    pickupMeeting(deps, { meeting: dialed.meeting_id });
    runAgentTurn.mockResolvedValueOnce({ stdout: "plain non-json output", stderr: "" });
    const result = await sendTurn(deps, { meeting: dialed.meeting_id, message: "hi" });
    expect(result.replyText).toBe("plain non-json output");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// wrapMeeting
// ──────────────────────────────────────────────────────────────────────────

describe("wrapMeeting", () => {
  it("moves active → closed and records outcome + ended_at", async () => {
    const { meeting: dialed } = dialMeeting(deps, {
      to: "openclaw-main",
      topic: "t",
      fromChannel: "telegram",
      fromChat: "1234567890",
    });
    pickupMeeting(deps, { meeting: dialed.meeting_id });
    tick(10_000);
    const result = await wrapMeeting(deps, {
      meeting: dialed.meeting_id,
      outcome: "root cause + fix shipped",
    });
    expect(result.meeting.status).toBe("closed");
    expect(result.meeting.outcome).toBe("root cause + fix shipped");
    expect(result.meeting.ended_at).toBe("2026-04-12T14:00:10Z");
    expect(result.path).toContain("/meetings/closed/");
  });

  it("posts a wrap frame via runAgentTurn unless --silent", async () => {
    const { meeting: dialed } = dialMeeting(deps, {
      to: "openclaw-main",
      topic: "t",
      fromChannel: "telegram",
      fromChat: "1234567890",
    });
    pickupMeeting(deps, { meeting: dialed.meeting_id });
    await wrapMeeting(deps, { meeting: dialed.meeting_id, outcome: "done" });
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    const args = runAgentTurn.mock.calls[0][0] as string[];
    expect(args[0]).toBe("message");
    expect(args[1]).toBe("send");
    const msgIdx = args.indexOf("--message");
    expect(args[msgIdx + 1]).toContain("MEETING WRAPPED");
  });

  it("skips channel post with --silent", async () => {
    const { meeting: dialed } = dialMeeting(deps, {
      to: "openclaw-main",
      topic: "t",
      fromChannel: "telegram",
      fromChat: "1234567890",
    });
    pickupMeeting(deps, { meeting: dialed.meeting_id });
    await wrapMeeting(deps, { meeting: dialed.meeting_id, silent: true });
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("throws on non-active meeting", async () => {
    const { meeting: dialed } = dialMeeting(deps, { to: "x", topic: "t" });
    await expect(wrapMeeting(deps, { meeting: dialed.meeting_id })).rejects.toThrow(/not active/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// listMeetings
// ──────────────────────────────────────────────────────────────────────────

describe("listMeetings", () => {
  it("returns meetings in all three states with state=all", async () => {
    const a = dialMeeting(deps, {
      to: "claude-code",
      topic: "a",
      fromChannel: "telegram",
      fromChat: "1",
    });
    tick(10);
    const b = dialMeeting(deps, {
      to: "claude-code",
      topic: "b",
      fromChannel: "telegram",
      fromChat: "1",
    });
    tick(10);
    const c = dialMeeting(deps, { to: "ops", topic: "c", fromChannel: "telegram", fromChat: "1" });
    pickupMeeting(deps, { meeting: b.meeting.meeting_id });
    pickupMeeting(deps, { meeting: c.meeting.meeting_id });
    await wrapMeeting(deps, { meeting: c.meeting.meeting_id, silent: true });

    const all = listMeetings(deps, { state: "all" });
    expect(all).toHaveLength(3);
    const byState = Object.fromEntries(all.map((m) => [m.meeting_id, m.status]));
    expect(byState[a.meeting.meeting_id]).toBe("pending");
    expect(byState[b.meeting.meeting_id]).toBe("active");
    expect(byState[c.meeting.meeting_id]).toBe("closed");
  });

  it("filters by target agent", () => {
    dialMeeting(deps, { to: "claude-code", topic: "a" });
    tick(10);
    dialMeeting(deps, { to: "ops", topic: "b" });
    const onlyCode = listMeetings(deps, { state: "all", to: "claude-code" });
    expect(onlyCode).toHaveLength(1);
    expect(onlyCode[0].to_agent).toBe("claude-code");
  });

  it("defaults to pending-only", () => {
    dialMeeting(deps, { to: "claude-code", topic: "a" });
    tick(10);
    const b = dialMeeting(deps, {
      to: "claude-code",
      topic: "b",
      fromChannel: "telegram",
      fromChat: "1",
    });
    pickupMeeting(deps, { meeting: b.meeting.meeting_id });
    const pending = listMeetings(deps);
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("pending");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// renderTranscript
// ──────────────────────────────────────────────────────────────────────────

describe("renderTranscript", () => {
  it("includes open frame, each turn, and wrap frame for closed meetings", async () => {
    const { meeting: dialed } = dialMeeting(deps, {
      to: "openclaw-main",
      topic: "sentinel polling",
      fromChannel: "telegram",
      fromChat: "1",
      from: "claude-code",
    });
    pickupMeeting(deps, { meeting: dialed.meeting_id });
    await sendTurn(deps, { meeting: dialed.meeting_id, message: "question 1" });
    await wrapMeeting(deps, { meeting: dialed.meeting_id, outcome: "done", silent: true });
    const shown = showMeeting(deps, dialed.meeting_id);
    const rendered = renderTranscript(shown);
    expect(rendered).toContain("MEETING OPENED");
    expect(rendered).toContain("sentinel polling");
    expect(rendered).toContain("question 1");
    expect(rendered).toContain("ok from mock");
    expect(rendered).toContain("MEETING WRAPPED");
  });

  it("notes active/pending meetings as still-running", () => {
    const { meeting: dialed } = dialMeeting(deps, { to: "x", topic: "t" });
    const rendered = renderTranscript(showMeeting(deps, dialed.meeting_id));
    expect(rendered).toContain("(meeting still pending)");
  });
});
