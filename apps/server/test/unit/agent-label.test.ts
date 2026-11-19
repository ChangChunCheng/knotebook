import { describe, expect, it } from "vitest";
import { AGENT_LABEL_RE, agentLabelOf, deriveAgentLabel } from "../../src/auth/agent-label.js";

describe("deriveAgentLabel", () => {
  it("derivation table: first token -> NFKC -> lowercase -> filter characters -> truncate to 32 -> 'agent' if empty", () => {
    expect(deriveAgentLabel("Claude Code (knotebook)")).toBe("claude");
    expect(deriveAgentLabel("MCP CLI Proxy")).toBe("mcp");
    expect(deriveAgentLabel("我的腳本")).toBe("agent");           // everything filtered out -> fallback
    expect(deriveAgentLabel("  spaced-out  name ")).toBe("spaced-out");
    expect(deriveAgentLabel("Ｂｏｔ")).toBe("bot");                 // NFKC: full-width -> half-width
    expect(deriveAgentLabel("a".repeat(40))).toBe("a".repeat(32)); // truncated to 32
    expect(deriveAgentLabel("")).toBe("agent");
    expect(deriveAgentLabel("!!!")).toBe("agent");
    expect(deriveAgentLabel("my-script.v2")).toBe("my-script.v2"); // . _ - are valid characters
    expect(deriveAgentLabel("cursor@2")).toBe("cursor2");          // @ is filtered out
    expect(deriveAgentLabel("  Ｃｌａｕｄｅ  ")).toBe("claude");    // trim + NFKC full-width
  });

  it("derived values match AGENT_LABEL_RE, and the RE is identical to the DB CHECK api_tokens_agent_label_chk", () => {
    for (const n of ["Claude Code (knotebook)", "我的腳本", "a".repeat(40), "", "!!!", "cursor@2", "my-script.v2"]) {
      expect(AGENT_LABEL_RE.test(deriveAgentLabel(n)), n).toBe(true);
    }
    // The CHECK in db/schema.ts is `~ '^[A-Za-z0-9._-]{1,32}$'`. If the two diverge, a PATCH passes the app layer
    // and then fails as a 500 at the DB.
    expect(AGENT_LABEL_RE.source).toBe("^[A-Za-z0-9._-]{1,32}$");
  });

  it("agentLabelOf: an override wins when the column is set, NULL falls back to the derived value (pure function, no DB)", () => {
    expect(agentLabelOf({ agentLabel: "bot-1", name: "Claude Code" })).toBe("bot-1");
    expect(agentLabelOf({ agentLabel: null, name: "Claude Code" })).toBe("claude");
    expect(agentLabelOf({ agentLabel: null, name: "" })).toBe("agent");
  });
});
