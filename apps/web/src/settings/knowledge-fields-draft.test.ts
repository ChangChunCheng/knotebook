import { describe, expect, it } from "vitest";
import { DEFAULT_KNOWLEDGE_FIELD_VIEW, type AdminKnowledgeFieldsDto } from "@knotebook/shared";
import { addCustomField, addOption, draftFromAdmin, enabledCustomCount, inputFromDraft, moveField, moveOption, setCustomKey, setCustomName, setOptionKey, setOptionName } from "./knowledge-fields-draft";

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

  describe("custom fields", () => {
    const owner = { key: "x-owner" as const, enabled: true, name: "Owner", type: "member" as const, builtin: false, options: [] };
    const scope = { key: "x-scope" as const, enabled: false, name: "Scope", type: "select" as const, builtin: false, options: [{ key: "site", name: "Site", enabled: true, builtin: false }] };
    const withCustom: AdminKnowledgeFieldsDto = { ...DTO, fields: [...DTO.fields, owner, scope] };

    it("inputFromDraft sends custom fields in list order with their type only when new", () => {
      let draft = draftFromAdmin(withCustom);
      draft = addCustomField(draft, { name: "Due", type: "date", key: "due" });
      const fields = inputFromDraft(draft).fields;
      expect(fields.slice(5)).toEqual([
        { key: "x-owner", name: "Owner", enabled: true },
        { key: "x-scope", name: "Scope", enabled: false, options: [{ key: "site", name: "Site", enabled: true }] },
        { key: "x-due", name: "Due", type: "date", enabled: true },
      ]);
      const reordered = inputFromDraft(moveField(draft, "x-due", -1)).fields.map((f) => f.key);
      expect(reordered.slice(5)).toEqual(["x-owner", "x-due", "x-scope"]);
    });

    it("addCustomField starts the new field off once 20 are on, and counts only enabled ones", () => {
      const many: AdminKnowledgeFieldsDto = {
        ...DTO,
        fields: [...DTO.fields, ...Array.from({ length: 20 }, (_, i) => ({ ...owner, key: `x-f${i}` as const, name: `F${i}` }))],
      };
      const draft = addCustomField(draftFromAdmin(many), { name: "Extra", type: "text", key: "extra" });
      expect(enabledCustomCount(draft)).toBe(20);
      expect(draft.fields.at(-1)).toMatchObject({ key: "x-extra", enabled: false, isNew: true });
      expect(addCustomField(draftFromAdmin(withCustom), { name: "Extra", type: "text", key: "extra" }).fields.at(-1)!.enabled).toBe(true);
    });

    it("only a field added in this session can have its key edited", () => {
      let draft = addCustomField(draftFromAdmin(withCustom), { name: "Mine", type: "text", key: "mine" });
      const index = draft.fields.length - 1;
      draft = setCustomKey(draft, index, "other");
      draft = setCustomName(draft, index, "Anything");
      expect(draft.fields[index]).toMatchObject({ key: "x-other", name: "Anything" });
      expect(setCustomKey(draft, 5, "changed").fields[5]!.key).toBe("x-owner");
    });

    it("moveField swaps only among custom fields and ignores moves past either end", () => {
      const draft = draftFromAdmin(withCustom);
      expect(moveField(draft, "x-owner", -1)).toBe(draft);
      expect(moveField(draft, "x-scope", 1)).toBe(draft);
      expect(moveField(draft, "x-owner", 1).fields.map((f) => f.key).slice(5)).toEqual(["x-scope", "x-owner"]);
    });
  });
});
