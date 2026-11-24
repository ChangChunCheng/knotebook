import { describe, expect, it } from "vitest";
import { DEFAULT_KNOWLEDGE_FIELD_VIEW, type KnowledgeInfo } from "@knotebook/shared";
import { draftForSave, draftOf, EMPTY_DRAFT, evidenceLabel, fieldOfError, isDraftFieldEnabled, singleLine, tooLongLength } from "./form-state";
import { fieldView } from "./test-support";

const INFO: KnowledgeInfo = { id: "k_00000001", when: "w", conclusion: "c", evidence: "docs", verified: "2026-01-01", status: "unverified", supersededBy: "" };

describe("form state", () => {
  it("draftOf drops the id and starts empty for a heading that is not knowledge yet", () => {
    expect(draftOf(INFO)).toEqual({ when: "w", conclusion: "c", evidence: "docs", verified: "2026-01-01", state: "needs-verify", supersededBy: "" });
    expect(draftOf(null)).toEqual(EMPTY_DRAFT);
    expect(EMPTY_DRAFT.state).toBe("needs-verify");
  });

  it("draftOf reads a heading saved without a status through its verified date", () => {
    expect(draftOf({ ...INFO, status: "" }).state).toBe("verified");
    expect(draftOf({ ...INFO, status: "", verified: "" }).state).toBe("needs-verify");
    expect(draftOf({ ...INFO, status: "outdated" }).state).toBe("obsolete");
  });

  it("singleLine turns every kind of line break into a space without trimming", () => {
    expect(singleLine("a\nb\r\nc\rd")).toBe("a b c d");
  });

  it("a replacement is kept only while the status is outdated", () => {
    const ref = "k_00000002";
    expect(draftForSave({ ...EMPTY_DRAFT, state: "obsolete", supersededBy: ref }).supersededBy).toBe(ref);
    expect(draftForSave({ ...EMPTY_DRAFT, state: "needs-verify", supersededBy: ref }).supersededBy).toBe("");
    expect(draftForSave({ ...EMPTY_DRAFT, state: "verified", supersededBy: ref }).supersededBy).toBe("");
  });

  it("maps each validation error to the field that shows it", () => {
    expect(fieldOfError("whenTooLong")).toBe("when");
    expect(fieldOfError("conclusionTooLong")).toBe("conclusion");
    expect(fieldOfError("verifiedInvalid")).toBe("verified");
    expect(fieldOfError("supersededSelf")).toBe("supersededBy");
    expect(fieldOfError("supersededInvalid")).toBe("supersededBy");
    expect(fieldOfError("clearedAll")).toBe("form");
  });

  it("maps the replacement to its setting key", () => {
    const fields = fieldView({ off: ["superseded_by"] });
    expect(isDraftFieldEnabled(fields, "supersededBy")).toBe(false);
    expect(isDraftFieldEnabled(fields, "when")).toBe(true);
    expect(isDraftFieldEnabled(DEFAULT_KNOWLEDGE_FIELD_VIEW, "supersededBy")).toBe(true);
  });

  it("names a basis by its option, marks a hidden or unknown one as turned off, and an empty one as not filled", () => {
    const t = (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key);
    const fields = fieldView({ options: [{ key: "docs", name: "Spec" }, { key: "inferred", enabled: false }] });
    expect(evidenceLabel(fields, "", t)).toBe("knowledge.notFilled");
    expect(evidenceLabel(fields, "tested", t)).toBe("knowledge.evidence.tested");
    expect(evidenceLabel(fields, "docs", t)).toBe("Spec");
    expect(evidenceLabel(fields, "inferred", t)).toBe('knowledge.turnedOff:{"name":"knowledge.evidence.inferred"}');
    expect(evidenceLabel(fields, "vendor-doc", t)).toBe('knowledge.turnedOff:{"name":"vendor-doc"}');
  });

  it("counts code points and reports a too-long field only after the user edited it", () => {
    const long = { ...EMPTY_DRAFT, when: "x".repeat(201), conclusion: "😀".repeat(300) };
    expect(tooLongLength("when", long, new Set())).toBeNull();
    expect(tooLongLength("when", long, new Set(["when"]))).toEqual({ max: 200, n: 201 });
    expect(tooLongLength("conclusion", long, new Set(["conclusion"]))).toBeNull();
  });
});
