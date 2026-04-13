import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";

const writeJsonFileAtomicallyMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/json-store", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/json-store")>(
    "openclaw/plugin-sdk/json-store",
  );
  writeJsonFileAtomicallyMock.mockImplementation(actual.writeJsonFileAtomically);
  return {
    ...actual,
    writeJsonFileAtomically: writeJsonFileAtomicallyMock,
  };
});

import {
  __testing,
  createTelegramThreadBindingManager,
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey,
} from "./thread-bindings.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("telegram thread bindings", () => {
  let stateDirOverride: string | undefined;

  beforeEach(async () => {
    writeJsonFileAtomicallyMock.mockClear();
    await __testing.resetTelegramThreadBindingsForTests();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await __testing.resetTelegramThreadBindingsForTests();
    if (stateDirOverride) {
      delete process.env.OPENCLAW_STATE_DIR;
      fs.rmSync(stateDirOverride, { recursive: true, force: true });
      stateDirOverride = undefined;
    }
  });

  it("registers a telegram binding adapter and binds current conversations", async () => {
    const manager = createTelegramThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
      idleTimeoutMs: 30_000,
      maxAgeMs: 0,
    });
    const bound = await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-1",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "work",
        conversationId: "-100200300:topic:77",
      },
      placement: "current",
      metadata: {
        boundBy: "user-1",
      },
    });

    expect(bound.conversation.channel).toBe("telegram");
    expect(bound.conversation.accountId).toBe("work");
    expect(bound.conversation.conversationId).toBe("-100200300:topic:77");
    expect(bound.targetSessionKey).toBe("agent:main:subagent:child-1");
    expect(manager.getByConversationId("-100200300:topic:77")?.boundBy).toBe("user-1");
  });

  it("rejects child placement when conversationId is a bare topic ID with no group context", async () => {
    createTelegramThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    await expect(
      getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "77",
        },
        placement: "child",
      }),
    ).rejects.toMatchObject({
      code: "BINDING_CREATE_FAILED",
    });
  });

  it("rejects child placement when parentConversationId is also a bare topic ID", async () => {
    createTelegramThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    await expect(
      getSessionBindingService().bind({
        targetSessionKey: "agent:main:acp:child-acp-1",
        targetKind: "session",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "77",
          parentConversationId: "99",
        },
        placement: "child",
      }),
    ).rejects.toMatchObject({
      code: "BINDING_CREATE_FAILED",
    });
  });

  it("shares binding state across distinct module instances", async () => {
    const bindingsA = await importFreshModule<typeof import("./thread-bindings.js")>(
      import.meta.url,
      "./thread-bindings.js?scope=shared-a",
    );
    const bindingsB = await importFreshModule<typeof import("./thread-bindings.js")>(
      import.meta.url,
      "./thread-bindings.js?scope=shared-b",
    );

    await bindingsA.__testing.resetTelegramThreadBindingsForTests();

    try {
      const managerA = bindingsA.createTelegramThreadBindingManager({
        accountId: "shared-runtime",
        persist: false,
        enableSweeper: false,
      });
      const managerB = bindingsB.createTelegramThreadBindingManager({
        accountId: "shared-runtime",
        persist: false,
        enableSweeper: false,
      });

      expect(managerB).toBe(managerA);

      await getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-shared",
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: "shared-runtime",
          conversationId: "-100200300:topic:44",
        },
        placement: "current",
      });

      expect(
        bindingsB
          .getTelegramThreadBindingManager("shared-runtime")
          ?.getByConversationId("-100200300:topic:44")?.targetSessionKey,
      ).toBe("agent:main:subagent:child-shared");
    } finally {
      await bindingsA.__testing.resetTelegramThreadBindingsForTests();
    }
  });

  it("updates lifecycle windows by session key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
    const manager = createTelegramThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-1",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "work",
        conversationId: "1234",
      },
    });
    const original = manager.listBySessionKey("agent:main:subagent:child-1")[0];
    expect(original).toBeDefined();

    const idleUpdated = setTelegramThreadBindingIdleTimeoutBySessionKey({
      accountId: "work",
      targetSessionKey: "agent:main:subagent:child-1",
      idleTimeoutMs: 2 * 60 * 60 * 1000,
    });
    vi.setSystemTime(new Date("2026-03-06T12:00:00.000Z"));
    const maxAgeUpdated = setTelegramThreadBindingMaxAgeBySessionKey({
      accountId: "work",
      targetSessionKey: "agent:main:subagent:child-1",
      maxAgeMs: 6 * 60 * 60 * 1000,
    });

    expect(idleUpdated).toHaveLength(1);
    expect(idleUpdated[0]?.idleTimeoutMs).toBe(2 * 60 * 60 * 1000);
    expect(maxAgeUpdated).toHaveLength(1);
    expect(maxAgeUpdated[0]?.maxAgeMs).toBe(6 * 60 * 60 * 1000);
    expect(maxAgeUpdated[0]?.boundAt).toBe(original?.boundAt);
    expect(maxAgeUpdated[0]?.lastActivityAt).toBe(Date.parse("2026-03-06T12:00:00.000Z"));
    expect(manager.listBySessionKey("agent:main:subagent:child-1")[0]?.maxAgeMs).toBe(
      6 * 60 * 60 * 1000,
    );
  });

  it("does not persist lifecycle updates when manager persistence is disabled", async () => {
    stateDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDirOverride;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));

    createTelegramThreadBindingManager({
      accountId: "no-persist",
      persist: false,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-2",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "no-persist",
        conversationId: "-100200300:topic:88",
      },
    });

    setTelegramThreadBindingIdleTimeoutBySessionKey({
      accountId: "no-persist",
      targetSessionKey: "agent:main:subagent:child-2",
      idleTimeoutMs: 60 * 60 * 1000,
    });
    setTelegramThreadBindingMaxAgeBySessionKey({
      accountId: "no-persist",
      targetSessionKey: "agent:main:subagent:child-2",
      maxAgeMs: 2 * 60 * 60 * 1000,
    });

    const statePath = path.join(
      resolveStateDir(process.env, os.homedir),
      "telegram",
      "thread-bindings-no-persist.json",
    );
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("persists unbinds before restart so removed bindings do not come back", async () => {
    stateDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDirOverride;

    createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    const bound = await getSessionBindingService().bind({
      targetSessionKey: "plugin-binding:openclaw-codex-app-server:abc123",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "8460800771",
      },
    });

    await getSessionBindingService().unbind({
      bindingId: bound.bindingId,
      reason: "test-detach",
    });

    await __testing.resetTelegramThreadBindingsForTests();

    const reloaded = createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("8460800771")).toBeUndefined();
  });

  it("flushes pending lifecycle update persists before test reset", async () => {
    stateDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDirOverride;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));

    createTelegramThreadBindingManager({
      accountId: "persist-reset",
      persist: true,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-3",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "persist-reset",
        conversationId: "-100200300:topic:99",
      },
    });

    setTelegramThreadBindingIdleTimeoutBySessionKey({
      accountId: "persist-reset",
      targetSessionKey: "agent:main:subagent:child-3",
      idleTimeoutMs: 90_000,
    });

    await __testing.resetTelegramThreadBindingsForTests();

    const statePath = path.join(
      resolveStateDir(process.env, os.homedir),
      "telegram",
      "thread-bindings-persist-reset.json",
    );
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      bindings?: Array<{ idleTimeoutMs?: number }>;
    };
    expect(persisted.bindings?.[0]?.idleTimeoutMs).toBe(90_000);
  });

  it("does not leak unhandled rejections when a persist write fails", async () => {
    stateDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDirOverride;
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const manager = createTelegramThreadBindingManager({
        accountId: "persist-failure",
        persist: true,
        enableSweeper: false,
      });

      await getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-persist-failure",
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: "persist-failure",
          conversationId: "-100200300:topic:100",
        },
      });

      writeJsonFileAtomicallyMock.mockImplementationOnce(async () => {
        throw new Error("persist boom");
      });
      manager.touchConversation("-100200300:topic:100");

      await __testing.resetTelegramThreadBindingsForTests();
      await flushMicrotasks();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  // Regression tests for the 2026-04-13 "grid chat frozen" bug.
  // Root cause: session-reset-service.ts called unbind unconditionally,
  // causing post-reset messages to reroute to the default agent whose
  // allowlist didn't include the group, producing "This group is not
  // allowed". Fix: session-reset now passes preserveBindings: true, and
  // the Telegram adapter early-returns when it sees that flag. These
  // tests pin that behavior so a future refactor can't silently
  // reintroduce the bug.

  it("honors preserveBindings=true — keeps records on session-reset", async () => {
    const manager = createTelegramThreadBindingManager({
      accountId: "preserve",
      persist: false,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:preserve-1",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "preserve",
        conversationId: "-100200300:topic:123",
      },
    });
    expect(manager.getByConversationId("-100200300:topic:123")).toBeDefined();

    // Simulate the reset flow — same shape emitSessionUnboundLifecycleEvent
    // uses when called from performGatewaySessionReset.
    await getSessionBindingService().unbind({
      targetSessionKey: "agent:main:subagent:preserve-1",
      reason: "session-reset",
      preserveBindings: true,
    });

    // Binding must survive: this is the behavior that fixes the bug.
    expect(manager.getByConversationId("-100200300:topic:123")).toBeDefined();
  });

  it("ignores preserveBindings on session-delete — still unbinds", async () => {
    const manager = createTelegramThreadBindingManager({
      accountId: "delete",
      persist: false,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:delete-1",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "delete",
        conversationId: "-100200300:topic:456",
      },
    });
    expect(manager.getByConversationId("-100200300:topic:456")).toBeDefined();

    // session-delete path never sets preserveBindings → unbind fires normally.
    await getSessionBindingService().unbind({
      targetSessionKey: "agent:main:subagent:delete-1",
      reason: "session-delete",
    });

    expect(manager.getByConversationId("-100200300:topic:456")).toBeUndefined();
  });
});
