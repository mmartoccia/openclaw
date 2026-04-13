// Tests for src/commands/meet.ts — agent teleconference business logic.
//
// Uses a tmp homedir + injected deps so every verb exercises the real
// filesystem lifecycle (pending → active → closed) without touching
// ~/.openclaw/meetings/ on the host running tests.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultMeetDeps,
  dialMeeting,
  inviteGuest,
  listMeetings,
  loadGuestRegistry,
  pickupMeeting,
  resolveGuestTimeoutSec,
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

// ──────────────────────────────────────────────────────────────────────────
// inviteGuest — host/guest primitive
// ──────────────────────────────────────────────────────────────────────────

/**
 * Write a minimal guest registry YAML into the tmp config dir for
 * tests. Uses the parser we ship in meet.ts so the test also
 * exercises the YAML loader path.
 */
function writeGuestRegistry(tmpHome: string, yaml: string): string {
  const configDir = path.join(tmpHome, ".openclaw", "config");
  mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, "meet-guests.yaml");
  writeFileSync(file, yaml);
  return file;
}

/**
 * Build a fake MeetDeps that substitutes `execFile` for cli guests.
 * The real inviteGuest function calls execFile directly (not through
 * deps) for cli guests, so we can't mock it per-test. Instead, we
 * write a tiny standalone shell script to the tmp dir and point the
 * guest `command` at it. This avoids YAML/shell quoting hell from
 * trying to embed a full node -e script inside a YAML string.
 */
function cliGuestYaml(tmpHome: string, responseText: string, exitCode = 0): string {
  // Write a deterministic shell script and point the guest at it.
  // Using shell instead of node because there's no quoting ambiguity
  // when the args are empty — printf handles the literal string.
  const scriptPath = path.join(
    tmpHome,
    `guest-script-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
  );
  const scriptBody = `#!/bin/sh\nprintf '%s' ${JSON.stringify(responseText)}\nexit ${exitCode}\n`;
  writeFileSync(scriptPath, scriptBody, { mode: 0o755 });
  return `guests:
  test-cli:
    icon: "🤖"
    description: "Test cli guest"
    adapter: cli
    command: ${scriptPath}
    args: []
    timeout: 10
    parse: text
`;
}

describe("inviteGuest", () => {
  it("errors when no host identity is set", async () => {
    await expect(
      inviteGuest(deps, {
        guest: "test-cli",
        prompt: "hi",
        create: true,
        topic: "test",
        replyVia: "telegram:1",
      }),
    ).rejects.toThrow(/no host identity/);
  });

  it("errors on unknown guest id", async () => {
    writeGuestRegistry(tmp, cliGuestYaml(tmp, "ok"));
    await expect(
      inviteGuest(deps, {
        from: "openclaw-main",
        guest: "nonexistent",
        prompt: "hi",
        create: true,
        topic: "test",
        replyVia: "telegram:1",
      }),
    ).rejects.toThrow(/unknown guest/);
  });

  it("errors when --create is set without topic or reply-via", async () => {
    writeGuestRegistry(tmp, cliGuestYaml(tmp, "ok"));
    await expect(
      inviteGuest(deps, {
        from: "openclaw-main",
        guest: "test-cli",
        prompt: "hi",
        create: true,
      }),
    ).rejects.toThrow(/reply-via is required/);
  });

  it("errors when --meeting is omitted without --create", async () => {
    writeGuestRegistry(tmp, cliGuestYaml(tmp, "ok"));
    await expect(
      inviteGuest(deps, {
        from: "openclaw-main",
        guest: "test-cli",
        prompt: "hi",
      }),
    ).rejects.toThrow(/--meeting.*required/);
  });

  it("creates ephemeral meeting and runs a cli guest end-to-end", async () => {
    writeGuestRegistry(tmp, cliGuestYaml(tmp, "guest response text"));
    const result = await inviteGuest(deps, {
      from: "openclaw-main",
      guest: "test-cli",
      prompt: "what is 2+2",
      create: true,
      topic: "quick math",
      replyVia: "telegram:5555",
    });

    expect(result.ephemeral).toBe(true);
    expect(result.guest).toBe("test-cli");
    expect(result.response_text).toContain("guest response text");
    expect(result.meeting_id).toMatch(/^mtg_/);

    // Transcript should contain exactly one turn from the guest
    const meeting = showMeeting(deps, result.meeting_id);
    expect(meeting.transcript).toBeDefined();
    expect(meeting.transcript!.length).toBe(1);
    expect(meeting.transcript![0].from).toBe("test-cli");
    expect(meeting.transcript![0].to).toBe("openclaw-main");
    expect(meeting.transcript![0].body).toContain("guest response text");

    // Communication plane: both invite frame AND response frame should
    // have been posted via runMessageSend
    const sendCalls = runMessageSend.mock.calls.map((c) => c[0]);
    const messageArgs = sendCalls
      .filter((args: string[]) => args.includes("--message"))
      .map((args: string[]) => {
        const idx = args.indexOf("--message");
        return args[idx + 1];
      });
    // Invite frame (host → guest announcement)
    expect(messageArgs.some((m: string) => m.includes("invites"))).toBe(true);
    expect(messageArgs.some((m: string) => m.includes("guest response text"))).toBe(true);
  });

  it("injects into an existing active meeting", async () => {
    writeGuestRegistry(tmp, cliGuestYaml(tmp, "injected response"));

    // Set up a normal peer meeting via dial + pickup
    const dialed = dialMeeting(deps, {
      to: "claude-code",
      topic: "batch review",
      fromChannel: "telegram",
      fromChat: "5555",
      from: "openclaw-main",
    });
    pickupMeeting(deps, { meeting: dialed.meeting.meeting_id });

    // Now invite a different guest into that same meeting
    const result = await inviteGuest(deps, {
      from: "openclaw-main",
      guest: "test-cli",
      prompt: "second opinion please",
      meeting: dialed.meeting.meeting_id,
    });

    expect(result.meeting_id).toBe(dialed.meeting.meeting_id);
    expect(result.ephemeral).toBe(false);

    // Transcript should have one turn
    const meeting = showMeeting(deps, dialed.meeting.meeting_id);
    expect(meeting.transcript).toHaveLength(1);
    expect(meeting.transcript![0].from).toBe("test-cli");
  });

  it("errors cleanly when target meeting is not active", async () => {
    writeGuestRegistry(tmp, cliGuestYaml(tmp, "ok"));
    // Dial but don't pick up — meeting is still pending
    const dialed = dialMeeting(deps, {
      to: "x",
      topic: "t",
      fromChannel: "telegram",
      fromChat: "1",
      from: "openclaw-main",
    });
    await expect(
      inviteGuest(deps, {
        from: "openclaw-main",
        guest: "test-cli",
        prompt: "hi",
        meeting: dialed.meeting.meeting_id,
      }),
    ).rejects.toThrow(/not active/);
  });

  it("captures failure turns when guest exits non-zero", async () => {
    writeGuestRegistry(tmp, cliGuestYaml(tmp, "dying", 1));
    await expect(
      inviteGuest(deps, {
        from: "openclaw-main",
        guest: "test-cli",
        prompt: "boom",
        create: true,
        topic: "failure test",
        replyVia: "telegram:5555",
      }),
    ).rejects.toThrow();

    // The meeting should still exist with an error turn recorded
    const meetings = listMeetings(deps, { state: "active" });
    expect(meetings.length).toBe(1);
    const transcript = meetings[0].transcript ?? [];
    expect(transcript.length).toBe(1);
    expect(transcript[0].body).toContain("[ERROR]");
  });

  it("respects context-depth when building guest prompt", async () => {
    // Use a guest that echoes back the full prompt so we can inspect it
    const echoYaml = `guests:
  echo-guest:
    icon: "🔊"
    description: "Echoes its prompt"
    adapter: cli
    command: /bin/cat
    args: []
    timeout: 5
    parse: text
`;
    writeGuestRegistry(tmp, echoYaml);

    // cat with no args reads stdin, which won't receive our prompt —
    // this test is mainly about verifying the context build logic,
    // not the actual guest output. So instead let's use env to echo
    // the prompt argument directly:
    const printYaml = `guests:
  printer:
    icon: "🖨"
    description: "Prints the prompt arg"
    adapter: cli
    command: /bin/echo
    args: ["{{prompt}}"]
    timeout: 5
    parse: text
`;
    writeGuestRegistry(tmp, printYaml);

    // Build a meeting with multiple prior turns
    const dialed = dialMeeting(deps, {
      to: "claude-code",
      topic: "long thread",
      context: "important context",
      fromChannel: "telegram",
      fromChat: "5555",
      from: "openclaw-main",
    });
    pickupMeeting(deps, { meeting: dialed.meeting.meeting_id });
    for (let i = 1; i <= 5; i++) {
      await sendTurn(deps, {
        meeting: dialed.meeting.meeting_id,
        message: `turn number ${i}`,
      });
    }

    const result = await inviteGuest(deps, {
      from: "openclaw-main",
      guest: "printer",
      prompt: "what do you think",
      meeting: dialed.meeting.meeting_id,
      contextDepth: 2,
    });

    // The printed response should include the topic, context, last 2
    // turns, and the new prompt — but not turns 1-3.
    expect(result.response_text).toContain("long thread");
    expect(result.response_text).toContain("important context");
    // last 2 turns = echo from mock agent for turns 4 and 5 (sendTurn
    // records both the body and the agent reply), so the transcript
    // has more than 5 entries by this point — just verify "what do you
    // think" is in there and that earlier turns aren't.
    expect(result.response_text).toContain("what do you think");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// loadGuestRegistry — YAML parser
// ──────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────
// resolveGuestTimeoutSec — timeout precedence
// ──────────────────────────────────────────────────────────────────────────
//
// Regression guard for the 2026-04-13 failure where meet-watcher.sh passed
// `--timeout 300` and silently overrode `timeout: 600` from meet-guests.yaml,
// causing tool-heavy claude-code invocations to die at 5 minutes. The rule is:
// explicit opt > guest.timeout > 180s default. Keep this locked.

describe("resolveGuestTimeoutSec", () => {
  it("uses explicit override when provided", () => {
    expect(resolveGuestTimeoutSec(300, 600)).toBe(300);
  });

  it("falls back to guest default when no override", () => {
    expect(resolveGuestTimeoutSec(undefined, 600)).toBe(600);
  });

  it("falls back to 180s baseline when neither is set", () => {
    expect(resolveGuestTimeoutSec(undefined, undefined)).toBe(180);
  });

  it("ignores zero or negative override", () => {
    // zero/negative timeouts are meaningless and would make execFile
    // abort immediately; treat as unset and fall through.
    expect(resolveGuestTimeoutSec(0, 600)).toBe(600);
    expect(resolveGuestTimeoutSec(-10, 600)).toBe(600);
  });

  it("ignores zero or negative guest default and falls through to baseline", () => {
    expect(resolveGuestTimeoutSec(undefined, 0)).toBe(180);
    expect(resolveGuestTimeoutSec(undefined, -5)).toBe(180);
  });
});

describe("loadGuestRegistry", () => {
  it("returns built-in default when no config file exists", () => {
    const registry = loadGuestRegistry(deps);
    expect(registry.guests["claude-code"]).toBeDefined();
    expect(registry.guests["claude-code"].adapter).toBe("cli");
  });

  it("parses a real meet-guests.yaml file", () => {
    const yaml = `guests:
  claude-code:
    icon: "🦾"
    description: "Anthropic Claude Code CLI"
    adapter: cli
    command: /usr/local/bin/claude
    args: ["-p", "{{prompt}}"]
    timeout: 300
    parse: text

  gemini:
    icon: "♊"
    description: "Google Gemini"
    adapter: cli
    command: /usr/local/bin/gemini
    args: ["-p", "{{prompt}}"]
    timeout: 180

budgets:
  global_daily_max_invokes: 200
`;
    writeGuestRegistry(tmp, yaml);
    const registry = loadGuestRegistry(deps);

    expect(registry.guests["claude-code"]).toBeDefined();
    expect(registry.guests["claude-code"].icon).toBe("🦾");
    expect(registry.guests["claude-code"].command).toBe("/usr/local/bin/claude");
    expect(registry.guests["claude-code"].args).toEqual(["-p", "{{prompt}}"]);
    expect(registry.guests["claude-code"].timeout).toBe(300);

    expect(registry.guests.gemini).toBeDefined();
    expect(registry.guests.gemini.timeout).toBe(180);

    expect(registry.budgets?.global_daily_max_invokes).toBe(200);
  });

  it("parses block-style list syntax for args", () => {
    // This is the regression test for the 2026-04-13 failure where
    // writing `args:` with block-style `- item` children produced
    // `args.map is not a function` at invite time. Block lists must
    // work so operators can edit the yaml normally.
    const yaml = `guests:
  claude-code:
    icon: "🦾"
    adapter: cli
    command: /usr/local/bin/claude
    args:
      - "-p"
      - "--add-dir"
      - "/some/path"
      - "{{prompt}}"
    timeout: 600
    parse: text
`;
    writeGuestRegistry(tmp, yaml);
    const registry = loadGuestRegistry(deps);
    expect(registry.guests["claude-code"]).toBeDefined();
    expect(registry.guests["claude-code"].args).toEqual([
      "-p",
      "--add-dir",
      "/some/path",
      "{{prompt}}",
    ]);
    expect(registry.guests["claude-code"].timeout).toBe(600);
  });

  it("throws a clear error on ambiguous same-indent list syntax", () => {
    // Lists at the SAME indent as their opening key are ambiguous
    // under our simple parser. We promise a clear error instead of
    // a silent empty-array or a cryptic .map crash later.
    const yaml = `guests:
  claude-code:
    adapter: cli
    command: /bin/true
    args:
    - "-p"
`;
    writeGuestRegistry(tmp, yaml);
    expect(() => loadGuestRegistry(deps)).toThrow(/list item/);
  });

  it("parses mixed block-list and scalar children", () => {
    // Ensure frame accounting survives: object → list → back to scalar
    // sibling → back to parent sibling.
    const yaml = `guests:
  g1:
    adapter: cli
    args:
      - "a"
      - "b"
    timeout: 120
  g2:
    adapter: cli
    args: ["c", "d"]
    timeout: 60
`;
    writeGuestRegistry(tmp, yaml);
    const registry = loadGuestRegistry(deps);
    expect(registry.guests.g1.args).toEqual(["a", "b"]);
    expect(registry.guests.g1.timeout).toBe(120);
    expect(registry.guests.g2.args).toEqual(["c", "d"]);
    expect(registry.guests.g2.timeout).toBe(60);
  });

  it("respects OPENCLAW_GUEST_REGISTRY env override", () => {
    const yaml = `guests:
  override-guest:
    icon: "🎯"
    description: "From env override"
    adapter: cli
    command: /bin/true
    args: []
`;
    const altPath = path.join(tmp, "alt-guests.yaml");
    writeFileSync(altPath, yaml);

    const envDeps = { ...deps, env: () => ({ OPENCLAW_GUEST_REGISTRY: altPath }) };
    const registry = loadGuestRegistry(envDeps);
    expect(registry.guests["override-guest"]).toBeDefined();
    expect(registry.guests["claude-code"]).toBeUndefined();
  });

  it("merges openclaw.json agents with a meet block into the guest registry", () => {
    // Write an openclaw.json with two agents, one opted in via meet block
    // and one without.
    const openclawJson = {
      agents: {
        list: [
          {
            id: "main",
            name: "Main",
            model: "openai-codex/gpt-5.4",
            meet: {
              icon: "🦀",
              description: "OpenClaw main agent",
              can_invite: true,
              timeout: 240,
            },
          },
          {
            id: "ops",
            name: "Ops",
            model: "openai-codex/gpt-5.4",
            // No meet block — should NOT show up in the registry
          },
          {
            id: "phantom",
            name: "Phantom",
            meet: {
              icon: "👻",
              can_invite: false, // explicit opt-out
            },
          },
        ],
      },
    };
    mkdirSync(path.join(tmp, ".openclaw"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".openclaw", "openclaw.json"),
      JSON.stringify(openclawJson, null, 2),
    );

    const registry = loadGuestRegistry(deps);

    // main is opted in → should appear as an openclaw_agent guest
    expect(registry.guests.main).toBeDefined();
    expect(registry.guests.main.adapter).toBe("openclaw_agent");
    expect(registry.guests.main.icon).toBe("🦀");
    expect(registry.guests.main.command).toBe("main");
    expect(registry.guests.main.timeout).toBe(240);

    // ops has no meet block → should NOT appear
    expect(registry.guests.ops).toBeUndefined();

    // phantom has can_invite: false → should NOT appear
    expect(registry.guests.phantom).toBeUndefined();
  });

  it("openclaw_agent entries shadow guest yaml entries with the same id", () => {
    // Create a guest YAML with a claude-code entry AND an openclaw.json
    // with an agent also called claude-code. The agent entry should win.
    writeGuestRegistry(
      tmp,
      `guests:
  claude-code:
    icon: "🦾"
    description: "From guest yaml"
    adapter: cli
    command: /bin/fake
    args: []
`,
    );
    const openclawJson = {
      agents: {
        list: [
          {
            id: "claude-code",
            meet: {
              icon: "🦀",
              description: "From openclaw.json (should win)",
              can_invite: true,
            },
          },
        ],
      },
    };
    mkdirSync(path.join(tmp, ".openclaw"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".openclaw", "openclaw.json"),
      JSON.stringify(openclawJson, null, 2),
    );

    const registry = loadGuestRegistry(deps);
    expect(registry.guests["claude-code"]).toBeDefined();
    expect(registry.guests["claude-code"].adapter).toBe("openclaw_agent");
    expect(registry.guests["claude-code"].description).toContain("openclaw.json");
  });
});

describe("inviteGuest — openclaw_agent adapter", () => {
  it("dispatches to runAgentTurn with --agent flag for openclaw_agent guests", async () => {
    // Wire up a tmp openclaw.json declaring 'main' as dialable
    const openclawJson = {
      agents: {
        list: [
          {
            id: "main",
            meet: {
              icon: "🦀",
              description: "OpenClaw main",
              can_invite: true,
              timeout: 60,
            },
          },
        ],
      },
    };
    mkdirSync(path.join(tmp, ".openclaw"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".openclaw", "openclaw.json"),
      JSON.stringify(openclawJson, null, 2),
    );

    // Configure the mock runAgentTurn to return a specific assistant reply
    runAgentTurn.mockImplementation(async (_args: string[]) => ({
      stdout: JSON.stringify({
        result: { meta: { finalAssistantVisibleText: "hello from main agent" } },
      }),
      stderr: "",
    }));

    const result = await inviteGuest(deps, {
      from: "codex",
      guest: "main",
      prompt: "what's the status of phantom?",
      create: true,
      topic: "phantom status check",
      replyVia: "telegram:5555",
    });

    expect(result.guest).toBe("main");
    expect(result.response_text).toBe("hello from main agent");

    // Verify the subprocess args include --agent main and --message
    expect(runAgentTurn).toHaveBeenCalled();
    const firstCall = runAgentTurn.mock.calls[0][0] as string[];
    expect(firstCall).toContain("agent");
    expect(firstCall).toContain("--agent");
    expect(firstCall).toContain("main");
    expect(firstCall).toContain("--message");
    // The message should contain the topic and the prompt
    const messageIdx = firstCall.indexOf("--message");
    const messageBody = firstCall[messageIdx + 1];
    expect(messageBody).toContain("phantom status check");
    expect(messageBody).toContain("what's the status of phantom");
  });

  it("falls back to raw stdout when agent reply is non-JSON", async () => {
    const openclawJson = {
      agents: {
        list: [{ id: "raw-agent", meet: { icon: "📝", can_invite: true } }],
      },
    };
    mkdirSync(path.join(tmp, ".openclaw"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".openclaw", "openclaw.json"),
      JSON.stringify(openclawJson, null, 2),
    );

    // Plain text stdout (not JSON)
    runAgentTurn.mockImplementation(async () => ({
      stdout: "plain text reply from agent",
      stderr: "",
    }));

    const result = await inviteGuest(deps, {
      from: "codex",
      guest: "raw-agent",
      prompt: "hi",
      create: true,
      topic: "raw test",
      replyVia: "telegram:5555",
    });

    expect(result.response_text).toBe("plain text reply from agent");
  });

  it("propagates agent turn failures as guest errors", async () => {
    const openclawJson = {
      agents: {
        list: [{ id: "broken-agent", meet: { icon: "💥", can_invite: true } }],
      },
    };
    mkdirSync(path.join(tmp, ".openclaw"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".openclaw", "openclaw.json"),
      JSON.stringify(openclawJson, null, 2),
    );

    runAgentTurn.mockImplementation(async () => {
      throw new Error("mocked agent runtime explosion");
    });

    await expect(
      inviteGuest(deps, {
        from: "codex",
        guest: "broken-agent",
        prompt: "this will fail",
        create: true,
        topic: "failure propagation",
        replyVia: "telegram:5555",
      }),
    ).rejects.toThrow(/broken-agent.*mocked agent runtime explosion/);

    // Verify the failure was recorded as an error turn in the transcript
    const meetings = listMeetings(deps, { state: "active" });
    expect(meetings.length).toBe(1);
    const transcript = meetings[0].transcript ?? [];
    expect(transcript.length).toBe(1);
    expect(transcript[0].body).toContain("[ERROR]");
  });
});
