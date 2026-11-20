import { describe, expect, it } from "vitest";
import {
  BLOCK_ANCHOR_RE,
  convertSiteLinks,
  escapeLinkText,
  linkText,
  mapInlineArrays,
  normalizeAnchor,
  parseSiteNoteHref,
  resolveFromList,
  targetFromList,
  wikilinkDisplayText,
  wikilinkHref,
  wikilinkPropsFromLink,
  wikilinkVisibleText,
  wikilinksToLinks,
  type SiteLinkCandidate,
} from "./site-link.js";

const ORIGIN = "https://kb.example.com";
const GID = "AAAAAAAA-1111-4111-8111-111111111111";
const NOTE_ID = "11111111-2222-4333-8444-555555555555";

describe("parseSiteNoteHref (the one criterion for an in-site URL)", () => {
  const ok = (href: string) => parseSiteNoteHref(href, ORIGIN);
  it("three shapes x relative", () => {
    expect(ok("/n/alice/my-note")).toEqual({ path: { kind: "n", handle: "alice", slug: "my-note" }, anchorBlockId: "" });
    expect(ok(`/g/${GID}/plan`)).toEqual({ path: { kind: "g", groupId: GID.toLowerCase(), slug: "plan" }, anchorBlockId: "" });
    expect(ok(`/notes/${NOTE_ID}`)).toEqual({ path: { kind: "ref", ref: NOTE_ID }, anchorBlockId: "" });
    expect(ok("/notes/old-vanity-slug")).toEqual({ path: { kind: "ref", ref: "old-vanity-slug" }, anchorBlockId: "" });
  });
  it("three shapes x same-origin absolute; `HTTPS:` / `Http:` are accepted in any case", () => {
    expect(ok(`${ORIGIN}/n/alice/my-note`)?.path).toEqual({ kind: "n", handle: "alice", slug: "my-note" });
    expect(ok(`HTTPS://kb.example.com/g/${GID}/plan`)?.path).toEqual({ kind: "g", groupId: GID.toLowerCase(), slug: "plan" });
    expect(ok(`Https://kb.example.com/notes/${NOTE_ID}`)?.path).toEqual({ kind: "ref", ref: NOTE_ID });
  });
  it("handle and slug normalisation: handle is ASCII lower-cased only, slug is NFC + lower-cased", () => {
    expect(ok("/n/Alice/My-Note")?.path).toEqual({ kind: "n", handle: "alice", slug: "my-note" });
  });
  it("#b-<id>: one matching BLOCK_ANCHOR_RE becomes anchorBlockId; a bad id, #/slide, other fragments -> null; an empty # is accepted", () => {
    expect(ok("/n/alice/x#b-abc_DEF-123")?.anchorBlockId).toBe("abc_DEF-123");
    expect(ok(`/notes/${NOTE_ID}#b-${"a".repeat(64)}`)?.anchorBlockId).toBe("a".repeat(64));
    expect(ok(`/notes/${NOTE_ID}#b-${"a".repeat(65)}`)).toBeNull();
    expect(ok("/n/alice/x#b-壞")).toBeNull();
    expect(ok("/n/alice/x#b-")).toBeNull();
    expect(ok("/n/alice/x#/slide-1")).toBeNull();
    expect(ok("/n/alice/x#top")).toBeNull();
    expect(ok("/n/alice/x#")).toEqual({ path: { kind: "n", handle: "alice", slug: "x" }, anchorBlockId: "" });
  });
  it("rejected: other origin, `//x`, `/\\x`, upper-case first segment, trailing slash, query, credentials, surrounding whitespace, relative path (not starting with /), other schemes", () => {
    for (const href of [
      "https://evil.example.com/n/alice/x",
      "http://kb.example.com/n/alice/x", // a different scheme = a different origin
      "//kb.example.com/n/alice/x",
      "/\\kb.example.com/n/alice/x",
      "/N/alice/x",
      "/Notes/" + NOTE_ID,
      "/n/alice/x/",
      "/n/alice/x?present",
      "/n/alice/x?",
      "https://u:p@kb.example.com/n/alice/x",
      " /n/alice/x",
      "/n/alice/x ",
      "n/alice/x",
      "mailto:a@b.c",
      "javascript:alert(1)",
      "https:n/alice/x", // a scheme-carrying relative URL: not an absolute URL
      "https:/n/alice/x",
      "HTTPS:../n/alice/x",
      "/p/alice/x",
      "/n/alice",
      "/n/alice/x/extra",
      "/g/not-a-uuid/x",
      "/notes",
      "",
    ]) {
      expect(ok(href), href).toBeNull();
    }
  });
  it("bad percent-encoding -> null (decodeURIComponent throws)", () => {
    expect(ok("/n/alice/%E0%A4%A")).toBeNull();
  });
  it("a percent-encoded CJK slug and an NFD slug both restore to NFC + lower case", () => {
    expect(ok("/n/alice/%E4%B8%AD%E6%96%87")?.path).toEqual({ kind: "n", handle: "alice", slug: "中文" });
    const nfd = "Café"; // e + U+0301
    expect(ok(`/n/alice/${encodeURIComponent(nfd)}`)?.path).toEqual({ kind: "n", handle: "alice", slug: "café" });
  });
});

describe("builders, anchor normalisation, display text", () => {
  it("wikilinkHref", () => {
    expect(wikilinkHref(NOTE_ID, "")).toBe(`/notes/${NOTE_ID}`);
    expect(wikilinkHref(NOTE_ID, "b1")).toBe(`/notes/${NOTE_ID}#b-b1`);
  });
  it("normalizeAnchor: anything not matching BLOCK_ANCHOR_RE becomes empty", () => {
    expect(BLOCK_ANCHOR_RE.source).toBe("^[A-Za-z0-9_-]{1,64}$");
    expect(normalizeAnchor("ok_1")).toBe("ok_1");
    expect(normalizeAnchor("壞")).toBe("");
    expect(normalizeAnchor(42)).toBe("");
    expect(normalizeAnchor(undefined)).toBe("");
  });
  it("wikilinkDisplayText and wikilinkVisibleText (never empty)", () => {
    expect(wikilinkDisplayText({ label: "L", snapshotTitle: "S" }, "Live")).toBe("L");
    expect(wikilinkDisplayText({ label: "", snapshotTitle: "S" }, "Live")).toBe("Live");
    expect(wikilinkDisplayText({ label: "", snapshotTitle: "S" })).toBe("S");
    expect(wikilinkDisplayText({ snapshotTitle: "" })).toBe("");
    expect(wikilinkVisibleText({ targetNoteId: NOTE_ID, label: "", snapshotTitle: "", anchorBlockId: "b2" })).toBe(`/notes/${NOTE_ID}#b-b2`);
    expect(wikilinkVisibleText({ targetNoteId: NOTE_ID, label: "", snapshotTitle: "", anchorBlockId: "壞" })).toBe(`/notes/${NOTE_ID}`);
  });
});

describe("label rules (one case for each of the three functions + snapshotTitle takes the original text)", () => {
  const target = { id: NOTE_ID.toUpperCase(), title: "Target Title" };
  const href = `/notes/${NOTE_ID}`;
  it("empty text -> label empty, snapshotTitle takes the target's title", () => {
    expect(wikilinkPropsFromLink({ text: "", href, target, anchorBlockId: "" })).toEqual({
      targetNoteId: NOTE_ID, snapshotTitle: "Target Title", label: "", anchorBlockId: "",
    });
  });
  it("text = target title -> label empty, snapshotTitle takes the original text", () => {
    expect(wikilinkPropsFromLink({ text: "Target Title", href, target, anchorBlockId: "x1" })).toEqual({
      targetNoteId: NOTE_ID, snapshotTitle: "Target Title", label: "", anchorBlockId: "x1",
    });
  });
  it("text = href (bare URL) -> label empty, snapshotTitle takes the original text (the target title the reader cannot see is not written into the document)", () => {
    expect(wikilinkPropsFromLink({ text: href, href, target, anchorBlockId: "" })).toEqual({
      targetNoteId: NOTE_ID, snapshotTitle: href, label: "", anchorBlockId: "",
    });
  });
  it("other text -> label = text (verbatim: no trim, no case change)", () => {
    expect(wikilinkPropsFromLink({ text: " target title ", href, target, anchorBlockId: "" })).toEqual({
      targetNoteId: NOTE_ID, snapshotTitle: " target title ", label: " target title ", anchorBlockId: "",
    });
  });
  it("targetNoteId is lower-cased (NOTE_ID is all digits so toUpperCase leaves it unchanged; hence an id with letters is used)", () => {
    const mixed = { id: "ABCDEF00-0000-4000-8000-00000000000A", title: "T" };
    expect(wikilinkPropsFromLink({ text: "", href, target: mixed, anchorBlockId: "" }).targetNoteId).toBe("abcdef00-0000-4000-8000-00000000000a");
  });
});

const CANDIDATES: SiteLinkCandidate[] = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", title: "Mine", slug: "mine", groupId: null, ownerHandle: "alice" },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", title: "Group Note", slug: "plan", groupId: GID.toLowerCase(), ownerHandle: null },
  { id: "aaaaaaaa-0000-4000-8000-000000000003", title: "中文", slug: "中文", groupId: null, ownerHandle: "alice" },
];

describe("resolveFromList (shared by the server's prefetched list and the web cache)", () => {
  it("n: personal note, handle + slug; a group note is not hit by /n/", () => {
    expect(resolveFromList({ kind: "n", handle: "alice", slug: "mine" }, CANDIDATES)?.title).toBe("Mine");
    expect(resolveFromList({ kind: "n", handle: "bob", slug: "mine" }, CANDIDATES)).toBeNull();
    expect(resolveFromList({ kind: "n", handle: "alice", slug: "plan" }, CANDIDATES)).toBeNull();
  });
  it("n: a group note does not hit even if ownerHandle and slug both match (groupId must be null)", () => {
    const groupOwned: SiteLinkCandidate[] = [
      { id: "aaaaaaaa-0000-4000-8000-000000000004", title: "Group Owned", slug: "same", groupId: GID.toLowerCase(), ownerHandle: "alice" },
    ];
    expect(resolveFromList({ kind: "n", handle: "alice", slug: "same" }, groupOwned)).toBeNull();
  });
  it("g: group id + slug", () => {
    expect(resolveFromList({ kind: "g", groupId: GID.toLowerCase(), slug: "plan" }, CANDIDATES)?.title).toBe("Group Note");
    expect(resolveFromList({ kind: "g", groupId: GID.toLowerCase(), slug: "mine" }, CANDIDATES)).toBeNull();
  });
  it("ref: uuid (any case) and vanity-uuid suffix; a legacy slug does not hit (left to the server fallback)", () => {
    expect(resolveFromList({ kind: "ref", ref: "AAAAAAAA-0000-4000-8000-000000000001" }, CANDIDATES)?.title).toBe("Mine");
    expect(resolveFromList({ kind: "ref", ref: "my-old-title-aaaaaaaa-0000-4000-8000-000000000002" }, CANDIDATES)?.title).toBe("Group Note");
    expect(resolveFromList({ kind: "ref", ref: "mine" }, CANDIDATES)).toBeNull();
  });
  it("an encoded CJK slug after parsing hits the note with the NFC slug", () => {
    const parsed = parseSiteNoteHref("/n/alice/%E4%B8%AD%E6%96%87", ORIGIN)!;
    expect(resolveFromList(parsed.path, CANDIDATES)?.title).toBe("中文");
  });
});

describe("targetFromList (the \"hit -> { id, title }\" shared by server writes, the web cache and in-site AI)", () => {
  it("a hit returns only { id, title } (no slug / groupId / ownerHandle); a miss returns undefined", () => {
    expect(targetFromList({ kind: "g", groupId: GID.toLowerCase(), slug: "plan" }, CANDIDATES)).toEqual({
      id: "aaaaaaaa-0000-4000-8000-000000000002", title: "Group Note",
    });
    expect(targetFromList({ kind: "ref", ref: "AAAAAAAA-0000-4000-8000-000000000001" }, CANDIDATES)).toEqual({
      id: "aaaaaaaa-0000-4000-8000-000000000001", title: "Mine",
    });
    expect(targetFromList({ kind: "n", handle: "alice", slug: "plan" }, CANDIDATES)).toBeUndefined();
  });
});

/** Synchronous resolution that only knows the candidate list (as used on the server write path). */
const resolveByList = (_href: string, parsed: { path: Parameters<typeof resolveFromList>[0] }) => targetFromList(parsed.path, CANDIDATES) ?? null;

describe("convertSiteLinks (inline, nested, both table cell shapes, styles dropped, unresolved count, input not mutated)", () => {
  const link = (href: string, ...content: unknown[]) => ({ type: "link", href, content });
  const t = (text: string, styles: Record<string, unknown> = {}) => ({ type: "text", text, styles });

  it("inline: resolvable -> wikilink (label rules + anchor); other sites and unresolvable ones are left untouched and counted as unresolved", () => {
    const blocks = [{ type: "paragraph", content: [
      t("see "),
      link("/n/alice/mine#b-h1", t("Mine")),
      t(" and "),
      link("https://other.example.com/x", t("ext")),
      t(" and "),
      link("/n/alice/missing", t("gone")),
    ], children: [] }];
    const before = JSON.stringify(blocks);
    const [out, stats] = convertSiteLinks(blocks, resolveByList, ORIGIN);
    expect(JSON.stringify(blocks)).toBe(before); // the input is not mutated
    expect(stats).toEqual({ converted: 1, unresolved: 1 });
    const content = (out[0] as { content: unknown[] }).content;
    expect(content[1]).toEqual({ type: "wikilink", props: { targetNoteId: CANDIDATES[0]!.id, snapshotTitle: "Mine", label: "", anchorBlockId: "h1" } });
    expect(content[3]).toEqual(link("https://other.example.com/x", t("ext")));
    expect(content[5]).toEqual(link("/n/alice/missing", t("gone")));
  });

  it("several styled fragments join into one label (styles dropped); two links with the same href are each converted and each keep their label", () => {
    const blocks = [{ type: "paragraph", content: [
      link("/n/alice/mine", t("粗", { bold: true }), t("體")),
      t(" / "),
      link("/n/alice/mine", t("另一段")),
    ] }];
    const [out, stats] = convertSiteLinks(blocks, resolveByList, ORIGIN);
    expect(stats.converted).toBe(2);
    const content = (out[0] as { content: Array<{ type: string; props?: { label: string } }> }).content;
    expect(content.map((n) => n.type)).toEqual(["wikilink", "text", "wikilink"]);
    expect(content[0]!.props!.label).toBe("粗體");
    expect(content[2]!.props!.label).toBe("另一段");
  });

  it("nested children are converted too; a block without in-site links stays the same object (copy-on-write)", () => {
    const untouched = { type: "paragraph", content: [t("plain")], children: [] };
    const blocks = [{ type: "bulletListItem", content: [t("a")], children: [
      untouched,
      { type: "paragraph", content: [link(`/g/${GID}/plan`, t("Group Note"))], children: [] },
    ] }];
    const [out] = convertSiteLinks(blocks, resolveByList, ORIGIN);
    const kids = (out[0] as { children: Array<{ content: Array<{ type: string }> }> }).children;
    expect(kids[0]).toBe(untouched);
    expect(kids[1]!.content[0]!.type).toBe("wikilink");
  });

  it("table: both the cell-is-an-array and the cell-is-{type:tableCell, content} shapes are converted", () => {
    const blocks = [{ type: "table", content: { type: "tableContent", columnWidths: [null, null], rows: [
      { cells: [[link("/n/alice/mine", t("Mine"))], { type: "tableCell", props: {}, content: [link(`/notes/${CANDIDATES[1]!.id}`, t("G"))] }] },
    ] }, children: [] }];
    const [out, stats] = convertSiteLinks(blocks, resolveByList, ORIGIN);
    expect(stats.converted).toBe(2);
    const rows = (out[0] as { content: { rows: Array<{ cells: unknown[] }> } }).content.rows;
    expect((rows[0]!.cells[0] as Array<{ type: string }>)[0]!.type).toBe("wikilink");
    const cell = rows[0]!.cells[1] as { type: string; props: unknown; content: Array<{ type: string; props: { label: string } }> };
    expect(cell.type).toBe("tableCell");
    expect(cell.props).toEqual({});
    expect(cell.content[0]).toMatchObject({ type: "wikilink", props: { label: "G" } });
  });

  it("in-site links of paragraphs inside columns are converted to wikilinks too", () => {
    const blocks = [{ type: "columnList", children: [
      { type: "column", props: { width: 1 }, children: [{ type: "paragraph", content: [link("/n/alice/mine", t("Mine"))], children: [] }] },
      { type: "column", props: { width: 1 }, children: [{ type: "paragraph", content: [t("plain")], children: [] }] },
    ] }];
    const [out, stats] = convertSiteLinks(blocks, resolveByList, ORIGIN);
    expect(stats).toEqual({ converted: 1, unresolved: 0 });
    const para = (out[0] as { children: Array<{ children: Array<{ content: unknown[] }> }> }).children[0]!.children[0]!;
    expect(para.content[0]).toEqual({ type: "wikilink", props: { targetNoteId: CANDIDATES[0]!.id, snapshotTitle: "Mine", label: "", anchorBlockId: "" } });
  });

  it("linkText: both strings and StyledText arrays are accepted", () => {
    expect(linkText("abc")).toBe("abc");
    expect(linkText([t("a"), t("b", { bold: true })])).toBe("ab");
    expect(linkText(undefined)).toBe("");
  });
});

describe("mapInlineArrays (the walker shared by rebindWikilinks and convertSiteLinks)", () => {
  it("isInlineType covers only ordinary blocks; table cells are always walked", () => {
    const seen: string[] = [];
    const blocks = [
      { type: "codeBlock", content: [{ type: "text", text: "code" }] },
      { type: "paragraph", content: [{ type: "text", text: "p" }] },
      { type: "table", content: { type: "tableContent", rows: [{ cells: [[{ type: "text", text: "c" }]] }] } },
    ];
    mapInlineArrays(blocks, (inline) => {
      seen.push(String((inline[0] as { text: string }).text));
      return inline;
    }, (type) => type === "paragraph");
    expect(seen).toEqual(["p", "c"]);
  });
});

describe("wikilinksToLinks (rewrites the copy for MCP reads and the in-site AI export)", () => {
  const wl = (props: Record<string, string>) => ({ type: "wikilink", props: { targetNoteId: NOTE_ID, snapshotTitle: "Snap", label: "", anchorBlockId: "", ...props } });
  it("label first; empty label uses titleOf; not found uses snapshotTitle; the anchor goes into href; tables too; input unchanged", () => {
    const blocks = [
      { type: "paragraph", content: [wl({ label: "L" }), wl({}), wl({ targetNoteId: "aaaaaaaa-0000-4000-8000-00000000000f" }), wl({ snapshotTitle: "", anchorBlockId: "b9" })] },
      { type: "table", content: { type: "tableContent", rows: [{ cells: [[wl({})]] }] } },
    ];
    const before = JSON.stringify(blocks);
    const out = wikilinksToLinks(blocks, (id) => (id === NOTE_ID ? "Live" : undefined));
    expect(JSON.stringify(blocks)).toBe(before);
    const p = (out[0] as { content: unknown[] }).content;
    expect(p[0]).toEqual({ type: "link", href: `/notes/${NOTE_ID}`, content: [{ type: "text", text: "L", styles: {} }] });
    expect(p[1]).toEqual({ type: "link", href: `/notes/${NOTE_ID}`, content: [{ type: "text", text: "Live", styles: {} }] });
    expect(p[2]).toEqual({ type: "link", href: "/notes/aaaaaaaa-0000-4000-8000-00000000000f", content: [{ type: "text", text: "Snap", styles: {} }] });
    expect(p[3]).toEqual({ type: "link", href: `/notes/${NOTE_ID}#b-b9`, content: [{ type: "text", text: "Live", styles: {} }] });
    const cell = (out[1] as { content: { rows: Array<{ cells: unknown[][] }> } }).content.rows[0]!.cells[0]!;
    expect(cell[0]).toMatchObject({ type: "link", href: `/notes/${NOTE_ID}` });
  });

  // #269: BlockNote's markdown export does not escape text; escaping is done by `escapeLinkText`, but only at the step that really becomes markdown
  // (the markdown branch of note-markdown-read.ts). `wikilinksToLinks` itself does **not escape**: on the read path its output also goes through the raw-HTML
  // output of coloured blocks, where escaping would add a layer of backslashes on every round trip. `<` that may open markup is escaped, `&` is not (see escapeLinkText).
  it("escapeLinkText escapes backslash, backtick, * _ [ ] ~ and a `<` that may open markup, leaves & alone; wikilinksToLinks outputs the original text in both paragraphs and table cells (no escaping)", () => {
    expect(escapeLinkText("[Draft] Plan *v2*")).toBe("\\[Draft\\] Plan \\*v2\\*");
    expect(escapeLinkText("a]b\\")).toBe("a\\]b\\\\");
    expect(escapeLinkText("a_b_ `c` ~~s~~ x|y")).toBe("a\\_b\\_ \\`c\\` \\~\\~s\\~\\~ x|y");
    expect(escapeLinkText("C:\\path\\")).toBe("C:\\\\path\\\\");
    expect(escapeLinkText("![img] #h")).toBe("!\\[img\\] #h");
    expect(escapeLinkText("foo]bar")).toBe("foo\\]bar");
    expect(escapeLinkText("a <d> &amp; b")).toBe("a \\<d> &amp; b");
    expect(escapeLinkText("<b>x</b>")).toBe("\\<b>x\\</b>");
    expect(escapeLinkText("2 < 3")).toBe("2 < 3");
    expect(escapeLinkText("a<")).toBe("a\\<");
    expect(escapeLinkText("\\<b>")).toBe("\\\\\\<b>");
    expect(escapeLinkText("&amp;")).toBe("&amp;");
    const blocks = [
      { type: "paragraph", content: [wl({ label: "a]b\\" })] },
      { type: "table", content: { type: "tableContent", rows: [{ cells: [[wl({})]] }] } },
    ];
    const out = wikilinksToLinks(blocks, () => "[Draft] Plan *v2*");
    expect((out[0] as { content: unknown[] }).content[0]).toEqual({ type: "link", href: `/notes/${NOTE_ID}`, content: [{ type: "text", text: "a]b\\", styles: {} }] });
    const cell = (out[1] as { content: { rows: Array<{ cells: unknown[][] }> } }).content.rows[0]!.cells[0]!;
    expect(cell[0]).toEqual({ type: "link", href: `/notes/${NOTE_ID}`, content: [{ type: "text", text: "[Draft] Plan *v2*", styles: {} }] });
  });
});
