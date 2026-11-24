import { describe, expect, it } from "vitest";
import { DEFAULT_KNOWLEDGE_FIELD_VIEW, type AdminKnowledgeFieldsDto } from "@knotebook/shared";
import { addOption, draftFromAdmin, inputFromDraft, moveOption, setOptionKey, setOptionName } from "./knowledge-fields-draft";

const DTO: AdminKnowledgeFieldsDto = {
  fields: DEFAULT_KNOWLEDGE_FIELD_VIEW.fields.map((f) => ({ ...f })),
  limits: { customEnabledMax: 20, customTotalMax: 100, optionsMax: 30, nameMax: 60 },
};

describe("knowledge fields draft", () => {
  it("inputFromDraft sends every builtin field without a name and every option, blank names as null", () => {
    const input = inputFromDraft(draftFromAdmin(DTO));
    expect(input.fields[0]).toEqual({ key: "when", enabled: true });
    expect(input.fields.map((f) => f.key)).toEqual(["when", "conclusion", "evidence", "verified", "superseded_by"]);
    expect(input.fields[2]).toEqual({
      key: "evidence",
      enabled: true,
      options: [
        { key: "tested", name: null, enabled: true },
        { key: "docs", name: null, enabled: true },
        { key: "inferred", name: null, enabled: true },
      ],
    });
  });

  it("moveOption swaps with the neighbour and ignores moves past either end", () => {
    const draft = draftFromAdmin(DTO);
    const keys = (d: typeof draft) => d.fields[2]!.options.map((o) => o.key);
    expect(keys(moveOption(draft, "evidence", 1, -1))).toEqual(["docs", "tested", "inferred"]);
    expect(keys(moveOption(draft, "evidence", 0, -1))).toEqual(["tested", "docs", "inferred"]);
    expect(keys(moveOption(draft, "evidence", 2, 1))).toEqual(["tested", "docs", "inferred"]);
  });

  it("a new option's key follows its name until the key is edited by hand", () => {
    let draft = addOption(draftFromAdmin(DTO), "evidence");
    draft = setOptionName(draft, "evidence", 3, "Vendor docs");
    expect(draft.fields[2]!.options[3]!.key).toBe("vendor-docs");
    draft = setOptionKey(draft, "evidence", 3, "vendor");
    draft = setOptionName(draft, "evidence", 3, "Vendor documents");
    expect(draft.fields[2]!.options[3]).toMatchObject({ key: "vendor", name: "Vendor documents" });
  });

  it("a new option's key avoids the reserved basis keys and existing keys", () => {
    let draft = addOption(draftFromAdmin(DTO), "evidence");
    draft = setOptionName(draft, "evidence", 3, "Docs");
    expect(draft.fields[2]!.options[3]!.key).toBe("docs-2");
    draft = setOptionName(draft, "evidence", 3, "Unconfirmed");
    expect(draft.fields[2]!.options[3]!.key).toBe("unconfirmed-2");
  });

  it("a name without ASCII letters keeps the generated key instead of re-rolling per keystroke", () => {
    let draft = addOption(draftFromAdmin(DTO), "evidence");
    draft = setOptionName(draft, "evidence", 3, "廠");
    const first = draft.fields[2]!.options[3]!.key;
    expect(first).toMatch(/^k[0-9a-z]{5}$/);
    draft = setOptionName(draft, "evidence", 3, "廠商文件");
    expect(draft.fields[2]!.options[3]!.key).toBe(first);
  });
});
