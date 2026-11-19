import { describe, expect, it } from "vitest";
import { AGENT_LABEL_RE, deriveAgentLabel } from "./agent-label.js";

// The full derivation table is pinned in apps/server/test/unit/agent-label.test.ts (runs unchanged); here only check that shared itself works (web imports it too).
describe("shared deriveAgentLabel", () => {
  it("first token -> NFKC -> lower case -> filter characters -> truncate to 32 -> agent if empty; the output passes AGENT_LABEL_RE", () => {
    expect(deriveAgentLabel("Claude Code (knotebook)")).toBe("claude");
    expect(deriveAgentLabel("我的腳本")).toBe("agent");
    expect(deriveAgentLabel("Ｂｏｔ")).toBe("bot");
    expect(AGENT_LABEL_RE.test(deriveAgentLabel("a".repeat(40)))).toBe(true);
    expect(AGENT_LABEL_RE.source).toBe("^[A-Za-z0-9._-]{1,32}$");
  });
});
