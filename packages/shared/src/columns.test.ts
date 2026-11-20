import { describe, expect, it } from "vitest";
import {
  COLUMN_BLOCK_TYPES, COLUMNS_OPEN_TAG, ColumnListNode, ColumnNode, columnBlockSpec, columnListBlockSpec, columnOpenTag,
  formatColumnWidth, parseColumnFlex,
} from "./columns.js";

// node environment, no editor mounted (cases that mount the editor are in web collab/schema.test.ts).

describe("formatColumnWidth: clamp to [0.1, 10], two decimals, strip trailing 0", () => {
  it.each([
    [1, "1"], [1.5, "1.5"], [0.75, "0.75"], [0.756, "0.76"], [2.0, "2"], [0.05, "0.1"], [0, "0.1"], [11, "10"],
    [NaN, "1"], [Infinity, "1"], [-3, "0.1"],
  ])("%s -> %s", (n, expected) => {
    expect(formatColumnWidth(n)).toBe(expected);
  });
});

describe("parseColumnFlex: only the first number of the flex property is recognised", () => {
  it.each<[string | null, number]>([
    ["flex:1.5", 1.5], ["flex: 2 1 0", 2], ["display:flex", 1], ["display:flex;gap:16px", 1], [null, 1], ["", 1],
    ["flex:20", 10], ["flex:0.01", 0.1], ["color:red;flex:3", 3], ["-webkit-flex:5", 1],
  ])("%j -> %s", (style, expected) => {
    expect(parseColumnFlex(style)).toBe(expected);
  });
});

describe("opening tag of external HTML", () => {
  it("columnOpenTag and COLUMNS_OPEN_TAG verbatim", () => {
    expect(columnOpenTag(1.5)).toBe('<div data-kb-column style="flex:1.5">');
    expect(COLUMNS_OPEN_TAG).toBe('<div data-kb-columns style="display:flex;gap:16px">');
  });
});

describe("node string guard", () => {
  it("type set, name, group, content, propSchema", () => {
    expect([...COLUMN_BLOCK_TYPES].sort()).toEqual(["column", "columnList"]);
    expect(ColumnListNode.name).toBe("columnList");
    expect(ColumnListNode.config.group).toBe("childContainer bnBlock blockGroupChild");
    expect(ColumnListNode.config.content).toBe("column column+");
    expect(ColumnNode.name).toBe("column");
    expect(ColumnNode.config.group).toBe("bnBlock childContainer");
    expect(ColumnNode.config.content).toBe("blockContainer+");
    expect(columnBlockSpec.config.propSchema).toEqual({ width: { default: 1 } });
    expect(columnListBlockSpec.config.propSchema).toEqual({});
    expect(columnBlockSpec.config.content).toBe("none");
    expect(columnListBlockSpec.config.content).toBe("none");
  });
});
