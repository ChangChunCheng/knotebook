import { describe, expect, it } from "vitest";
import { SHORTCUT_CATEGORIES, SHORTCUTS, visibleShortcuts } from "./shortcut-list";

/**
 * Entry data and filtering. The two-way check between list ids and e2e tags is in shortcut-e2e-coverage.test.ts;
 * this file guards only the data shape and the site capability filtering.
 */

const ids = (site: { aiAvailable: boolean; aiInstruct: boolean }) => visibleShortcuts(site).flatMap((g) => g.entries.map((e) => e.id));

describe("categories", () => {
  it("are in the prescribed order", () => {
    expect([...SHORTCUT_CATEGORIES]).toEqual(["global", "typing", "markdown", "formatting", "columns", "sidebar", "presentation", "ai", "mouse"]);
  });
});

describe("entry data", () => {
  it("non-empty", () => expect(SHORTCUTS.length).toBeGreaterThan(0));
  it("ids are unique", () => {
    const all = SHORTCUTS.map((e) => e.id);
    expect(new Set(all).size).toBe(all.length);
  });
  it("each entry's category is in the list", () => {
    for (const e of SHORTCUTS) expect(SHORTCUT_CATEGORIES, e.id).toContain(e.category);
  });
  it("each entry has at least one way to press", () => {
    for (const e of SHORTCUTS) expect(e.keys.length, e.id).toBeGreaterThan(0);
  });
});

describe("site capability filtering", () => {
  it("AI all off: no entry with requires, no ai category", () => {
    const groups = visibleShortcuts({ aiAvailable: false, aiInstruct: false });
    const shown = groups.flatMap((g) => g.entries);
    expect(shown.some((e) => e.requires !== undefined)).toBe(false);
    expect(groups.some((g) => g.category === "ai")).toBe(false);
  });

  it("AI all on: aiSelect, aiSend, aiClose are all present", () => {
    expect(ids({ aiAvailable: true, aiInstruct: true })).toEqual(expect.arrayContaining(["aiSelect", "aiSend", "aiClose"]));
  });

  it("AI present without Instruct: aiSelect and aiClose present, aiSend absent", () => {
    const shown = ids({ aiAvailable: true, aiInstruct: false });
    expect(shown).toEqual(expect.arrayContaining(["aiSelect", "aiClose"]));
    expect(shown).not.toContain("aiSend");
  });

  it("none of the three combinations returns an empty category, and the category order follows SHORTCUT_CATEGORIES", () => {
    for (const site of [
      { aiAvailable: false, aiInstruct: false },
      { aiAvailable: true, aiInstruct: false },
      { aiAvailable: true, aiInstruct: true },
    ]) {
      const groups = visibleShortcuts(site);
      expect(groups.length).toBeGreaterThan(0);
      for (const g of groups) expect(g.entries.length, g.category).toBeGreaterThan(0);
      const order = groups.map((g) => SHORTCUT_CATEGORIES.indexOf(g.category));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
  });
});

describe("redo", () => {
  it("Mac is listed separately and excludes Y (Chrome on Mac uses Cmd+Y for history)", () => {
    const redo = SHORTCUTS.find((e) => e.id === "redo");
    expect(redo, "redo 條目").toBeDefined();
    expect(redo!.macKeys, "redo 的 macKeys").toBeDefined();
    const macTokens = redo!.macKeys!.flatMap((k) => (k.kind === "combo" ? k.keys : []));
    expect(macTokens).not.toContain("Y");
    expect(macTokens).toEqual(["Mod", "Shift", "Z"]);
  });
});

describe("separator semantics for multiple ways (sep)", () => {
  it("every entry with two or more keys has sep", () => {
    for (const e of SHORTCUTS) if (e.keys.length > 1) expect(e.sep, e.id).toBeDefined();
  });

  it("different actions (pair) versus different ways of doing the same thing (or)", () => {
    const sepOf = (id: string) => SHORTCUTS.find((e) => e.id === id)?.sep;
    for (const id of ["indent", "moveBlock", "presentNav", "heading", "checklist", "aiSend", "inlineMarks"]) expect(sepOf(id), id).toBe("pair");
    for (const id of ["redo", "bullet"]) expect(sepOf(id), id).toBe("or");
  });
});
