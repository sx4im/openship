import { describe, expect, it } from "vitest";
import { resolveAgentSearchPath } from "../src/engine/modules/assistant/native-target";

const GUI_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

describe("resolveAgentSearchPath (#1669)", () => {
  it("appends the well-known macOS install dirs to a minimal GUI PATH", () => {
    const result = resolveAgentSearchPath(GUI_PATH, "/Users/tester", "darwin");
    expect(result.split(":")).toEqual([
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/Users/tester/.local/bin",
      "/Users/tester/.bun/bin",
      "/Users/tester/.npm-global/bin",
      "/Users/tester/.claude/local",
    ]);
  });

  it("does not duplicate dirs already on PATH", () => {
    const result = resolveAgentSearchPath(
      "/opt/homebrew/bin:/usr/bin:/bin",
      "/Users/tester",
      "darwin",
    );
    expect(result.split(":").filter((entry) => entry === "/opt/homebrew/bin")).toHaveLength(1);
    expect(result.startsWith("/opt/homebrew/bin:/usr/bin:/bin")).toBe(true);
  });

  it("keeps the inherited PATH untouched on Linux", () => {
    expect(resolveAgentSearchPath(GUI_PATH, "/home/tester", "linux")).toBe(GUI_PATH);
  });

  it("falls back to the default PATH when none is inherited", () => {
    const result = resolveAgentSearchPath(undefined, "/Users/tester", "darwin");
    expect(result.startsWith("/usr/local/bin:/usr/bin:/bin")).toBe(true);
    expect(result).toContain("/opt/homebrew/bin");
  });
});
