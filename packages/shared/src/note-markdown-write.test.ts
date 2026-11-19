import { describe, expect, it } from "vitest";
import { canonicalColumnsLine, normalizeTableWidths, relativizeSiteUploads } from "./note-markdown-write.js";

// Columns writing. Node environment: only the three functions that need no DOM; the syntax check (needs a DOM) is in server
// `test/unit/note-markdown-validate.test.ts`.

describe("canonicalColumnsLine: only an exactly canonical line counts", () => {
  it("outer line -> list; column line -> { width }", () => {
    expect(canonicalColumnsLine('<div data-kb-columns style="display:flex;gap:16px">')).toBe("list");
    expect(canonicalColumnsLine('<div data-kb-column style="flex:1.5">')).toEqual({ width: 1.5 });
  });

  it("one trailing carriage return is accepted", () => {
    expect(canonicalColumnsLine('<div data-kb-columns style="display:flex;gap:16px">\r')).toBe("list");
    expect(canonicalColumnsLine('<div data-kb-column style="flex:1.5">\r')).toEqual({ width: 1.5 });
  });

  it.each([["0.1", 0.1], ["10", 10], ["2.25", 2.25], ["1", 1]])("flex:%s accepted", (s, w) => {
    expect(canonicalColumnsLine(`<div data-kb-column style="flex:${s}">`)).toEqual({ width: w });
  });

  it.each([
    '<div data-kb-column style="flex:0.05">',
    '<div data-kb-column style="flex:10.5">',
    '<div data-kb-column style="flex:01">',
    '<div data-kb-column style="flex:1.555">',
    '<div data-kb-column style="flex:1.">',
    '<div data-kb-column style="flex:-1">',
    '<div data-kb-column style="flex:1e1">',
    ' <div data-kb-column style="flex:1">',
    '<div data-kb-column style="flex:1"> ',
    " <div data-kb-columns style=\"display:flex;gap:16px\">",
    "<div data-kb-columns style=\"display:flex;gap:16px\"> ",
    "<div data-kb-column style='flex:1'>",
    "<div data-kb-columns style='display:flex;gap:16px'>",
    '<div style="flex:1" data-kb-column>',
    '<div style="display:flex;gap:16px" data-kb-columns>',
    '<DIV DATA-KB-COLUMN STYLE="flex:1">',
    '<DIV DATA-KB-COLUMNS STYLE="display:flex;gap:16px">',
    '<div data-kb-column style="flex:1">\r\r',
  ])("%j -> null", line => {
    expect(canonicalColumnsLine(line)).toBeNull();
  });
});

const table = (columnWidths: unknown[]) => ({ type: "table", props: {}, content: { type: "tableContent", columnWidths, rows: [] }, children: [] });
const para = (children: unknown[] = []) => ({ type: "paragraph", props: {}, content: [], children });
const widthsOf = (b: unknown): unknown[] => (b as { content: { columnWidths: unknown[] } }).content.columnWidths;

describe("normalizeTableWidths: non-positive or non-finite numbers -> undefined", () => {
  it("[120, NaN, 80] -> [120, undefined, 80]", () => {
    const out = normalizeTableWidths([table([120, NaN, 80])]);
    expect(widthsOf(out[0])).toEqual([120, undefined, 80]);
    expect(widthsOf(out[0])[1]).toBeUndefined();
  });

  it.each<[string, number[]]>([["[NaN, NaN]", [NaN, NaN]], ["[0, -5]", [0, -5]]])("%s -> all undefined", (_name, ws) => {
    const out = normalizeTableWidths([table(ws)]);
    expect(widthsOf(out[0])).toEqual([undefined, undefined]);
    expect(widthsOf(out[0]).every(v => v === undefined)).toBe(true);
  });

  it("the same handling inside columnList -> column -> table", () => {
    const blocks = [{ type: "columnList", props: {}, children: [{ type: "column", props: { width: 1 }, children: [table([NaN, 120])] }, { type: "column", props: { width: 1 }, children: [para()] }] }];
    const out = normalizeTableWidths(blocks) as unknown as Array<{ children: Array<{ children: unknown[] }> }>;
    expect(widthsOf(out[0]!.children[0]!.children[0])).toEqual([undefined, 120]);
    expect(widthsOf(out[0]!.children[0]!.children[0])[0]).toBeUndefined();
    expect(out[0]!.children[1]).toBe(blocks[0]!.children[1]); // unchanged branches reuse the original object
  });

  it("nothing to change -> returns the same array", () => {
    const blocks = [table([120, undefined, 80]), para([table([300])])];
    expect(normalizeTableWidths(blocks)).toBe(blocks);
  });

  it("the input object is not mutated", () => {
    const t = table([120, NaN, 80]);
    const blocks = [para([t])];
    const out = normalizeTableWidths(blocks);
    expect(out).not.toBe(blocks);
    expect(Number.isNaN(widthsOf(t)[1])).toBe(true);
    expect(blocks[0]!.children[0]).toBe(t);
  });
});

const U = "00000000-0000-4000-8000-000000000001";
const media = (type: string, url: string, children: unknown[] = []) => ({ type, props: { url, name: "n" }, children });
const urlOf = (b: unknown): unknown => (b as { props: { url: unknown } }).props.url;

describe("relativizeSiteUploads: same-origin /api/uploads/<uuid> is restored to the relative form", () => {
  const BASE = "http://localhost";

  it("top-level image", () => {
    const out = relativizeSiteUploads([media("image", `http://localhost/api/uploads/${U}`)], BASE);
    expect(urlOf(out[0])).toBe(`/api/uploads/${U}`);
  });

  it("images, videos and files inside columns (columnList -> column -> image) and in paragraph children are restored the same way", () => {
    const abs = `http://localhost/api/uploads/${U}`;
    const blocks = [
      { type: "columnList", props: {}, children: [{ type: "column", props: { width: 1 }, children: [media("image", abs)] }, { type: "column", props: { width: 1 }, children: [para()] }] },
      para([media("image", abs), media("video", abs), media("file", abs)]),
    ];
    const out = relativizeSiteUploads(blocks, BASE) as unknown as Array<{ children: Array<{ children?: unknown[] }> }>;
    expect(urlOf(out[0]!.children[0]!.children![0])).toBe(`/api/uploads/${U}`);
    expect(out[1]!.children.map(urlOf)).toEqual([`/api/uploads/${U}`, `/api/uploads/${U}`, `/api/uploads/${U}`]);
  });

  it.each([
    `https://evil.example/api/uploads/${U}`,
    `http://localhost:8080/api/uploads/${U}`,
    `https://localhost/api/uploads/${U}`,
    "http://localhost/api/uploads/not-a-uuid",
    `http://localhost/api/uploads/${U}/x`,
    `http://localhost/api/uploads/${U}?x=1`,
    `http://localhost/api/uploads/${U}#a`,
    `http://u:p@localhost/api/uploads/${U}`,
    `http://localhost/other/${U}`,
    `/api/uploads/${U}`,
    "",
  ])("untouched: %j", url => {
    const blocks = [media("image", url)];
    const out = relativizeSiteUploads(blocks, BASE);
    expect(urlOf(out[0])).toBe(url);
    expect(out).toBe(blocks);
  });

  it("nothing to change -> returns the same array", () => {
    const blocks = [para([media("image", `/api/uploads/${U}`)]), media("file", "https://evil.example/a.pdf")];
    expect(relativizeSiteUploads(blocks, BASE)).toBe(blocks);
  });

  it("the input object is not mutated", () => {
    const abs = `http://localhost/api/uploads/${U}`;
    const img = media("image", abs);
    const blocks = [para([img])];
    const out = relativizeSiteUploads(blocks, BASE);
    expect(out).not.toBe(blocks);
    expect(urlOf(img)).toBe(abs);
    expect(blocks[0]!.children[0]).toBe(img);
  });
});
