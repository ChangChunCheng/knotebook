import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import { CUSTOM_COLORS_STYLE_ID, resetCustomColorsForTest } from "@/lib/custom-colors";
import { resetRecentColorsForTest } from "@/lib/recent-colors";
import { createTestEditor, renderAiHost, selectInBlock } from "@/test/ai-host";
import { applyColor } from "./apply-color";

beforeEach(() => {
  localStorage.clear();
  resetRecentColorsForTest();
});
afterEach(() => {
  resetCustomColorsForTest();
});

function selectors(): string[] {
  const sheet = (document.getElementById(CUSTOM_COLORS_STYLE_ID) as HTMLStyleElement | null)?.sheet;
  return sheet ? Array.from(sheet.cssRules).map((r) => (r as CSSStyleRule).selectorText) : [];
}

function setup() {
  const editor = createTestEditor([
    { id: "p1", type: "paragraph", content: "hello world" },
    { id: "p2", type: "paragraph", content: "second" },
    { id: "c1", type: "codeBlock", content: "let a" },
  ]);
  renderAiHost({ editor });
  return editor;
}

type Cell = { props: Record<string, string>; content: { text: string }[] };
function cellAt(ed: ReturnType<typeof setup>, r: number, c: number): Cell {
  const t = ed.getBlock("t1")!.content as unknown as { rows: { cells: Cell[] }[] };
  return t.rows[r]!.cells[c]!;
}
function setupTable() {
  const editor = createTestEditor([
    {
      id: "t1",
      type: "table",
      content: {
        type: "tableContent",
        rows: [{ cells: ["a", "b"] }, { cells: ["c", "d"] }],
      },
    },
    { id: "p1", type: "paragraph", content: "after" },
  ]);
  renderAiHost({ editor });
  return editor;
}
function remoteEditText(ed: ReturnType<typeof setup>, r: number, c: number, text: string): void {
  const block = ed.getBlock("t1")!;
  const t = block.content as unknown as { rows: { cells: unknown[] }[] };
  const rows = t.rows.map((row, ri) => ({
    ...row,
    cells: row.cells.map((cell, ci) => (ri === r && ci === c ? { ...(cell as object), content: [{ type: "text", text, styles: {} }] } : cell)),
  }));
  act(() => {
    ed.updateBlock(block, { type: "table", content: { ...t, rows } } as never);
  });
}

describe("applyColor tables", () => {
  it("applying a background hex to a cell changes only that cell", () => {
    const ed = setupTable();
    let ok = false;
    act(() => {
      ok = applyColor(ed, "background", { kind: "cell", blockId: "t1", rowIndex: 1, colIndex: 0 }, "#FF6600");
    });
    expect(ok).toBe(true);
    expect(cellAt(ed, 1, 0).props.backgroundColor).toBe("#ff6600");
    expect(cellAt(ed, 0, 0).props.backgroundColor).toBe("default");
    expect(cellAt(ed, 0, 1).props.backgroundColor).toBe("default");
    expect(cellAt(ed, 1, 1).props.backgroundColor).toBe("default");
    expect(selectors()).toContain('[data-background-color="#ff6600"]');
  });

  it("applying a text hex to a rowcol column changes the 2nd cell of both rows and not the 1st; rows likewise", () => {
    const ed = setupTable();
    act(() => {
      applyColor(ed, "text", { kind: "rowcol", blockId: "t1", orientation: "column", index: 1 }, "#0000ff");
    });
    expect(cellAt(ed, 0, 1).props.textColor).toBe("#0000ff");
    expect(cellAt(ed, 1, 1).props.textColor).toBe("#0000ff");
    expect(cellAt(ed, 0, 0).props.textColor).toBe("default");
    expect(cellAt(ed, 1, 0).props.textColor).toBe("default");
    act(() => {
      applyColor(ed, "background", { kind: "rowcol", blockId: "t1", orientation: "row", index: 0 }, "#00ff00");
    });
    expect(cellAt(ed, 0, 0).props.backgroundColor).toBe("#00ff00");
    expect(cellAt(ed, 0, 1).props.backgroundColor).toBe("#00ff00");
    expect(cellAt(ed, 1, 0).props.backgroundColor).toBe("default");
  });

  it("cell: apply, remote edits text, apply again - the remote text stays and both colors are kept", () => {
    const ed = setupTable();
    act(() => {
      applyColor(ed, "background", { kind: "cell", blockId: "t1", rowIndex: 0, colIndex: 1 }, "#ff6600");
    });
    remoteEditText(ed, 0, 0, "remote");
    act(() => {
      applyColor(ed, "background", { kind: "cell", blockId: "t1", rowIndex: 1, colIndex: 1 }, "#ff6600");
    });
    expect(cellAt(ed, 0, 0).content[0]!.text).toBe("remote");
    expect(cellAt(ed, 0, 1).props.backgroundColor).toBe("#ff6600");
    expect(cellAt(ed, 1, 1).props.backgroundColor).toBe("#ff6600");
  });

  it("rowcol: color column 0, remote edits the text of (1,1), color column 1 - the remote text stays and both columns are colored", () => {
    const ed = setupTable();
    act(() => {
      applyColor(ed, "background", { kind: "rowcol", blockId: "t1", orientation: "column", index: 0 }, "#ff6600");
    });
    remoteEditText(ed, 1, 1, "remote");
    act(() => {
      applyColor(ed, "background", { kind: "rowcol", blockId: "t1", orientation: "column", index: 1 }, "#ff6600");
    });
    expect(cellAt(ed, 1, 1).content[0]!.text).toBe("remote");
    for (const [r, c] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) expect(cellAt(ed, r, c).props.backgroundColor).toBe("#ff6600");
  });

  it("an out-of-range index or an already deleted block returns false, the document is unchanged and no rule is registered", () => {
    const ed = setupTable();
    const before = JSON.stringify(ed.document);
    expect(applyColor(ed, "background", { kind: "cell", blockId: "t1", rowIndex: 5, colIndex: 0 }, "#ff6600")).toBe(false);
    expect(applyColor(ed, "background", { kind: "cell", blockId: "t1", rowIndex: 0, colIndex: 9 }, "#ff6600")).toBe(false);
    expect(applyColor(ed, "background", { kind: "rowcol", blockId: "t1", orientation: "row", index: 7 }, "#ff6600")).toBe(false);
    expect(applyColor(ed, "background", { kind: "rowcol", blockId: "t1", orientation: "column", index: 7 }, "#ff6600")).toBe(false);
    expect(JSON.stringify(ed.document)).toBe(before);
    expect(selectors()).toEqual([]);
    act(() => {
      ed.removeBlocks(["t1"]);
    });
    expect(applyColor(ed, "background", { kind: "cell", blockId: "t1", rowIndex: 0, colIndex: 0 }, "#ff6600")).toBe(false);
    expect(applyColor(ed, "background", { kind: "rowcol", blockId: "t1", orientation: "row", index: 0 }, "#ff6600")).toBe(false);
    expect(selectors()).toEqual([]);
  });

  it("a non-table block returns false; palette names register no rule", () => {
    const ed = setupTable();
    expect(applyColor(ed, "background", { kind: "cell", blockId: "p1", rowIndex: 0, colIndex: 0 }, "#ff6600")).toBe(false);
    act(() => {
      applyColor(ed, "text", { kind: "cell", blockId: "t1", rowIndex: 0, colIndex: 0 }, "red");
    });
    expect(cellAt(ed, 0, 0).props.textColor).toBe("red");
    expect(selectors()).toEqual([]);
  });
});

describe("applyColor", () => {
  it("inline hex: styles are written in canonical form and only an inline rule is registered; default removes it", () => {
    const ed = setup();
    selectInBlock(ed, "p1", 0, 5);
    let ok = false;
    act(() => {
      ok = applyColor(ed, "text", { kind: "inline" }, "#F60");
    });
    expect(ok).toBe(true);
    const first = (ed.document[0]!.content as { text: string; styles: Record<string, string> }[])[0]!;
    expect(first.styles.textColor).toBe("#ff6600");
    const sels = selectors();
    expect(sels).toContain('[data-style-type="textColor"][data-value="#ff6600"]');
    expect(sels.some((s) => s.startsWith('[data-text-color="#ff6600"]') || s.includes(":has("))).toBe(false);

    selectInBlock(ed, "p1", 0, 5);
    act(() => {
      applyColor(ed, "text", { kind: "inline" }, "default");
    });
    const after = (ed.document[0]!.content as { styles: Record<string, string> }[])[0]!;
    expect(after.styles.textColor).toBeUndefined();
  });

  it("block background hex: props are written in canonical form and a block rule is registered", () => {
    const ed = setup();
    let ok = false;
    act(() => {
      ok = applyColor(ed, "background", { kind: "block", blockId: "p1" }, "#00FF00");
    });
    expect(ok).toBe(true);
    expect(ed.getBlock("p1")!.props.backgroundColor).toBe("#00ff00");
    expect(selectors()).toContain('[data-background-color="#00ff00"]');
  });

  it("a value that is not a color returns false and the document is unchanged", () => {
    const ed = setup();
    selectInBlock(ed, "p1", 0, 5);
    const before = JSON.stringify(ed.document);
    expect(applyColor(ed, "text", { kind: "inline" }, "tomato")).toBe(false);
    expect(applyColor(ed, "background", { kind: "block", blockId: "p1" }, "tomato")).toBe(false);
    expect(JSON.stringify(ed.document)).toBe(before);
  });

  it("a block that no longer exists returns false without throwing and registers no rule", () => {
    const ed = setup();
    act(() => {
      ed.removeBlocks(["p1"]);
    });
    let ok = true;
    expect(() => {
      ok = applyColor(ed, "background", { kind: "block", blockId: "p1" }, "#00ff00");
    }).not.toThrow();
    expect(ok).toBe(false);
    expect(selectors()).toEqual([]);
  });

  it("a block kind without the prop (codeBlock has no backgroundColor) returns false and registers no rule", () => {
    const ed = setup();
    expect(ed.getBlock("c1")!.props).not.toHaveProperty("backgroundColor");
    const before = JSON.stringify(ed.document);
    expect(applyColor(ed, "background", { kind: "block", blockId: "c1" }, "#00ff00")).toBe(false);
    expect(JSON.stringify(ed.document)).toBe(before);
    expect(selectors()).toEqual([]);
  });

  it("palette names are written as is and register no rule (inline and block)", () => {
    const ed = setup();
    selectInBlock(ed, "p1", 0, 5);
    let ok = false;
    act(() => {
      ok = applyColor(ed, "text", { kind: "inline" }, "red");
    });
    expect(ok).toBe(true);
    expect((ed.document[0]!.content as { styles: Record<string, string> }[])[0]!.styles.textColor).toBe("red");
    act(() => {
      ok = applyColor(ed, "background", { kind: "block", blockId: "p2" }, "blue");
    });
    expect(ok).toBe(true);
    expect(ed.getBlock("p2")!.props.backgroundColor).toBe("blue");
    expect(selectors()).toEqual([]);
  });
});
