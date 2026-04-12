// Minimal tests for /octo chat slash command handler.
//
// Focused on the dispatch shape: no-match / help / octo-disabled / read-only
// happy paths / mutating-action confirm gate. Does not exercise the full
// OctopusInstance — the runtime registry is mocked to return a stub with
// just the registry methods the handler touches.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handleOctoCommand } from "./commands-octo.js";
import type { HandleCommandsParams } from "./commands-types.js";

const getOctoRuntimeInstanceMock = vi.hoisted(() => vi.fn());

vi.mock("../../octo/runtime-registry.js", () => ({
  getOctoRuntimeInstance: getOctoRuntimeInstanceMock,
}));

function buildParams(
  commandBodyNormalized: string,
  overrides?: Partial<HandleCommandsParams["command"]>,
): HandleCommandsParams {
  return {
    cfg: {} as OpenClawConfig,
    ctx: {
      Provider: "web",
      Surface: "web",
      CommandSource: "text",
      GatewayClientScopes: ["operator.admin"],
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "op1",
      channel: "web",
      channelId: "web",
      surface: "web",
      ownerList: [],
      rawBodyNormalized: commandBodyNormalized,
      ...overrides,
    },
    sessionKey: "web:op1",
    workspaceDir: "/tmp",
    provider: "web",
    model: "test",
    contextTokens: 0,
    defaultGroupActivation: () => "always",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
  } as unknown as HandleCommandsParams;
}

function stubOcto(overrides: Record<string, unknown> = {}) {
  return {
    services: {
      registry: {
        listMissions: vi.fn(() => []),
        listArms: vi.fn(() => []),
        listGrips: vi.fn(() => []),
        getMission: vi.fn(() => null),
        getArm: vi.fn(() => null),
        getGrip: vi.fn(() => null),
        ...overrides.registry,
      },
      elo: {
        listRatings: vi.fn(() => []),
        ...overrides.elo,
      },
      handlers: {
        missionAbort: vi.fn(),
        missionPause: vi.fn(),
        missionResume: vi.fn(),
        armTerminate: vi.fn(),
        ...overrides.handlers,
      },
    },
    config: { enabled: true },
  };
}

describe("handleOctoCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when allowTextCommands is false", async () => {
    const result = await handleOctoCommand(buildParams("/octo"), false);
    expect(result).toBeNull();
  });

  it("returns null when the body is not an /octo command", async () => {
    const result = await handleOctoCommand(buildParams("/help"), true);
    expect(result).toBeNull();
  });

  it("prints help on /octo with no args", async () => {
    getOctoRuntimeInstanceMock.mockReturnValue(stubOcto());
    const result = await handleOctoCommand(buildParams("/octo"), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Usage: /octo");
  });

  it("explains when octo is not enabled", async () => {
    getOctoRuntimeInstanceMock.mockReturnValue(null);
    const result = await handleOctoCommand(buildParams("/octo status"), true);
    expect(result?.reply?.text).toContain("not enabled");
  });

  it("rejects unauthorized senders", async () => {
    getOctoRuntimeInstanceMock.mockReturnValue(stubOcto());
    const result = await handleOctoCommand(
      buildParams("/octo status", { isAuthorizedSender: false }),
      true,
    );
    expect(result?.shouldContinue).toBe(false);
    // No reply payload when silently ignoring an unauthorized sender.
    expect(result?.reply).toBeUndefined();
  });

  it("lists missions when they exist", async () => {
    const missions = [
      {
        mission_id: "mis_a",
        status: "active",
        title: "Refactor",
        owner: "op",
        policy_profile_ref: null,
        spec: {},
        metadata: null,
        created_at: 0,
        updated_at: 0,
        version: 0,
      },
    ];
    const octo = stubOcto({ registry: { listMissions: vi.fn(() => missions) } });
    getOctoRuntimeInstanceMock.mockReturnValue(octo);
    const result = await handleOctoCommand(buildParams("/octo mission list"), true);
    expect(result?.reply?.text).toContain("mis_a");
    expect(result?.reply?.text).toContain("Refactor");
  });

  it("reports empty elo table", async () => {
    getOctoRuntimeInstanceMock.mockReturnValue(stubOcto());
    const result = await handleOctoCommand(buildParams("/octo elo"), true);
    expect(result?.reply?.text).toContain("No Elo ratings yet");
  });

  it("lists elo ratings when they exist", async () => {
    const octo = stubOcto({
      elo: {
        listRatings: vi.fn(() => [
          {
            runtime_name: "claude",
            rating: 1532.5,
            games: 3,
            wins: 2,
            losses: 1,
            ties: 0,
            last_updated: 0,
          },
        ]),
      },
    });
    getOctoRuntimeInstanceMock.mockReturnValue(octo);
    const result = await handleOctoCommand(buildParams("/octo elo"), true);
    expect(result?.reply?.text).toContain("claude");
    expect(result?.reply?.text).toContain("1532");
  });

  describe("mutating actions with --yes gate", () => {
    it("refuses /octo mission abort without --yes and shows preview", async () => {
      const mission = {
        mission_id: "mis_x",
        status: "active",
        title: "Build refactor",
        owner: "op",
        policy_profile_ref: null,
        spec: {},
        metadata: null,
        created_at: 0,
        updated_at: 0,
        version: 0,
      };
      const octo = stubOcto({
        registry: {
          getMission: vi.fn(() => mission),
          listArms: vi.fn(() => [
            { arm_id: "a1", state: "active" },
            { arm_id: "a2", state: "completed" },
          ]),
        },
      });
      getOctoRuntimeInstanceMock.mockReturnValue(octo);
      const result = await handleOctoCommand(buildParams("/octo mission abort mis_x"), true);
      expect(result?.reply?.text).toContain("About to abort");
      expect(result?.reply?.text).toContain("Re-run with --yes");
      expect(octo.services.handlers.missionAbort).not.toHaveBeenCalled();
    });

    it("executes /octo mission abort --yes", async () => {
      const mission = {
        mission_id: "mis_x",
        status: "active",
        title: "Build refactor",
        owner: "op",
        policy_profile_ref: null,
        spec: {},
        metadata: null,
        created_at: 0,
        updated_at: 0,
        version: 0,
      };
      const octo = stubOcto({
        registry: {
          getMission: vi.fn(() => mission),
          listArms: vi.fn(() => []),
        },
        handlers: {
          missionAbort: vi
            .fn()
            .mockResolvedValue({ mission_id: "mis_x", status: "aborted", arms_terminated: 2 }),
        },
      });
      getOctoRuntimeInstanceMock.mockReturnValue(octo);
      const result = await handleOctoCommand(buildParams("/octo mission abort mis_x --yes"), true);
      expect(octo.services.handlers.missionAbort).toHaveBeenCalledTimes(1);
      expect(result?.reply?.text).toContain("aborted");
      expect(result?.reply?.text).toContain("2");
    });

    it("refuses /octo arm terminate without --yes", async () => {
      const arm = {
        arm_id: "arm_1",
        mission_id: "mis_x",
        agent_id: "claude",
        state: "active",
        adapter_type: "pty_tmux",
      };
      const octo = stubOcto({
        registry: { getArm: vi.fn(() => arm) },
      });
      getOctoRuntimeInstanceMock.mockReturnValue(octo);
      const result = await handleOctoCommand(buildParams("/octo arm terminate arm_1"), true);
      expect(result?.reply?.text).toContain("About to terminate");
      expect(octo.services.handlers.armTerminate).not.toHaveBeenCalled();
    });

    it("executes /octo arm terminate --yes", async () => {
      const arm = {
        arm_id: "arm_1",
        mission_id: "mis_x",
        agent_id: "claude",
        state: "active",
        adapter_type: "pty_tmux",
      };
      const octo = stubOcto({
        registry: { getArm: vi.fn(() => arm) },
        handlers: {
          armTerminate: vi.fn().mockResolvedValue({
            arm_id: "arm_1",
            terminated: true,
            final_status: "stopped",
          }),
        },
      });
      getOctoRuntimeInstanceMock.mockReturnValue(octo);
      const result = await handleOctoCommand(buildParams("/octo arm terminate arm_1 --yes"), true);
      expect(octo.services.handlers.armTerminate).toHaveBeenCalledTimes(1);
      expect(result?.reply?.text).toContain("terminated=true");
    });

    it("rejects mutating commands without a target id", async () => {
      getOctoRuntimeInstanceMock.mockReturnValue(stubOcto());
      const result = await handleOctoCommand(buildParams("/octo mission abort --yes"), true);
      expect(result?.reply?.text).toContain("Usage:");
    });
  });
});
