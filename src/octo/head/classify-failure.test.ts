import { describe, expect, it } from "vitest";
import { classifyFailure } from "./classify-failure.ts";

describe("classifyFailure", () => {
  it("returns null for empty / clean output", () => {
    expect(classifyFailure("")).toBeNull();
    expect(classifyFailure("everything ran fine")).toBeNull();
    expect(classifyFailure("task completed successfully")).toBeNull();
  });

  describe("auth_required", () => {
    it("matches 401 Unauthorized", () => {
      expect(classifyFailure("HTTP 401 Unauthorized")).toBe("auth_required");
      expect(classifyFailure("Error: 401 UNAUTHORIZED")).toBe("auth_required");
    });

    it("matches authentication-phrase variants", () => {
      expect(classifyFailure("you are not authenticated")).toBe("auth_required");
      expect(classifyFailure("authentication failed for this request")).toBe("auth_required");
      expect(classifyFailure("authentication expired, please retry")).toBe("auth_required");
      expect(classifyFailure("please re-authenticate to continue")).toBe("auth_required");
      expect(classifyFailure("Please log in again")).toBe("auth_required");
      expect(classifyFailure("please sign in")).toBe("auth_required");
    });

    it("matches token / api-key expired or invalid", () => {
      expect(classifyFailure("API key expired")).toBe("auth_required");
      expect(classifyFailure("token invalid")).toBe("auth_required");
      expect(classifyFailure("api_key missing")).toBe("auth_required");
      expect(classifyFailure("invalid credentials")).toBe("auth_required");
      expect(classifyFailure("session expired, try again")).toBe("auth_required");
    });

    it("matches provider-specific phrases", () => {
      expect(classifyFailure("OpenAI API key not configured")).toBe("auth_required");
      expect(classifyFailure("ANTHROPIC API KEY missing")).toBe("auth_required");
    });
  });

  describe("rate_limited", () => {
    it("matches 429 and rate-limit phrases", () => {
      expect(classifyFailure("HTTP 429 Too Many Requests")).toBe("rate_limited");
      expect(classifyFailure("you are being rate-limited")).toBe("rate_limited");
      expect(classifyFailure("rate limiting kicked in")).toBe("rate_limited");
      expect(classifyFailure("quota exceeded for this minute")).toBe("rate_limited");
    });
  });

  describe("network_error", () => {
    it("matches common Node network error codes", () => {
      expect(classifyFailure("connect ECONNREFUSED 127.0.0.1:443")).toBe("network_error");
      expect(classifyFailure("ENOTFOUND api.example.com")).toBe("network_error");
      expect(classifyFailure("ETIMEDOUT on getaddrinfo")).toBe("network_error");
      expect(classifyFailure("network unreachable")).toBe("network_error");
    });
  });

  describe("cli_not_found", () => {
    it("matches shell 'command not found' messages", () => {
      expect(classifyFailure("bash: claude: command not found")).toBe("cli_not_found");
      expect(classifyFailure("/usr/bin/env: node: No such file or directory")).toBe(
        "cli_not_found",
      );
    });
  });

  describe("out_of_memory", () => {
    it("matches OOM signatures", () => {
      expect(classifyFailure("FATAL ERROR: JavaScript heap out of memory")).toBe("out_of_memory");
      expect(classifyFailure("Process killed\nKilled")).toBe("out_of_memory");
      expect(classifyFailure("OOM killer invoked")).toBe("out_of_memory");
    });
  });

  describe("precedence", () => {
    it("returns the first matching signature in SIGNATURES order", () => {
      // auth_required comes before rate_limited — if both match, auth wins.
      const text = "401 Unauthorized and 429 Too Many Requests";
      expect(classifyFailure(text)).toBe("auth_required");
    });
  });

  describe("tail window", () => {
    it("only scans the last 8192 bytes of long outputs", () => {
      const prefix = "a".repeat(20000);
      // Signature at the very end — should be found.
      expect(classifyFailure(prefix + "\n401 Unauthorized")).toBe("auth_required");
      // Signature only at the start, beyond the 8KB tail — should NOT be found.
      const padding = "x".repeat(20000);
      expect(classifyFailure("401 Unauthorized\n" + padding)).toBeNull();
    });
  });
});
