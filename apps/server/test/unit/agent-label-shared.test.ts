/** #247: the derivation rule lives only in shared; the server must re-export the same function and regex, not a copy. */
import { describe, expect, it } from "vitest";
import * as shared from "@knotebook/shared";
import { AGENT_LABEL_RE, deriveAgentLabel } from "../../src/auth/agent-label.js";

describe("agent label derivation rule lives in shared", () => {
  it("server's deriveAgentLabel/AGENT_LABEL_RE are the same references as shared's", () => {
    expect(typeof shared.deriveAgentLabel).toBe("function");
    expect(deriveAgentLabel).toBe(shared.deriveAgentLabel);
    expect(AGENT_LABEL_RE).toBe(shared.AGENT_LABEL_RE);
  });
});
