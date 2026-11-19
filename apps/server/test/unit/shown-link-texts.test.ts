/**
 * #387: when `edit_note` writes back, the text of a link the reader saw without custom text must not be frozen into custom text (`notes/editing/shown-link-texts.ts`).
 * This file pins the memory itself (who, which target, which text, how long, the cap) and the traversal on read; the write-side integration behaviour is in `test/mcp-edit-note-linklabel.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { ShownLinkTexts, shownLinkTextsOf } from "../../src/notes/editing/shown-link-texts.js";

const T = "abcdef00-0000-4000-8000-00000000000a";
const T2 = "abcdef00-0000-4000-8000-00000000000b";

describe("ShownLinkTexts", () => {
  it("only a recorded (user, target, text) hits; another user, another target or another text does not; the target id is case-insensitive", () => {
    const m = new ShownLinkTexts();
    m.record("u1", { free: [[T, "Target v1"]], custom: [] });
    expect(m.has("u1", T, "Target v1")).toBe(true);
    expect(m.has("u1", T.toUpperCase(), "Target v1")).toBe(true);
    expect(m.has("u2", T, "Target v1")).toBe(false);
    expect(m.has("u1", T2, "Target v1")).toBe(false);
    expect(m.has("u1", T, "Target v2")).toBe(false);
    expect(m.has("u1", T, "target v1")).toBe(false);
  });

  it("past the retention period it no longer hits and is removed from the table", () => {
    let now = 1000;
    const m = new ShownLinkTexts({ ttlMs: 100, now: () => now });
    m.record("u1", { free: [[T, "A"]], custom: [] });
    now = 1099;
    expect(m.has("u1", T, "A")).toBe(true);
    now = 1100;
    expect(m.has("u1", T, "A")).toBe(false);
    expect(m.size).toBe(0);
  });

  it("reading the same link again recomputes the expiry", () => {
    let now = 0;
    const m = new ShownLinkTexts({ ttlMs: 100, now: () => now });
    m.record("u1", { free: [[T, "A"]], custom: [] });
    now = 90;
    m.record("u1", { free: [[T, "A"]], custom: [] });
    now = 150;
    expect(m.has("u1", T, "A")).toBe(true);
  });

  it("reading a custom-text link for the same target and text removes the earlier record; when one read has both kinds, the one without custom text wins", () => {
    const m = new ShownLinkTexts();
    m.record("u1", { free: [[T, "A"]], custom: [] });
    m.record("u1", { free: [], custom: [[T, "A"]] });
    expect(m.has("u1", T, "A")).toBe(false);
    m.record("u1", { free: [[T, "A"]], custom: [[T, "A"]] });
    expect(m.has("u1", T, "A")).toBe(true);
    // custom text removes only the same user's record
    m.record("u2", { free: [[T, "B"]], custom: [] });
    m.record("u1", { free: [], custom: [[T, "B"]] });
    expect(m.has("u2", T, "B")).toBe(true);
  });

  it("over the cap -> the oldest is dropped; a re-recorded entry counts as new", () => {
    const m = new ShownLinkTexts({ max: 3 });
    m.record("u1", { free: [[T, "1"], [T, "2"], [T, "3"]], custom: [] });
    m.record("u1", { free: [[T, "1"]], custom: [] });
    m.record("u1", { free: [[T, "4"]], custom: [] });
    expect(m.size).toBe(3);
    expect(m.has("u1", T, "2")).toBe(false);
    expect(["1", "3", "4"].map(t => m.has("u1", T, t))).toEqual([true, true, true]);
  });

  it("each account has its own cap: exceeding it drops only that account's oldest, other accounts (even older ones) are unaffected", () => {
    const m = new ShownLinkTexts({ max: 100, perUserMax: 2 });
    m.record("u2", { free: [[T, "a"]], custom: [] });
    m.record("u1", { free: [[T, "1"], [T, "2"]], custom: [] });
    m.record("u1", { free: [[T, "3"]], custom: [] });
    expect(m.size).toBe(3);
    expect(["1", "2", "3"].map(t => m.has("u1", T, t))).toEqual([false, true, true]);
    expect(m.has("u2", T, "a")).toBe(true);
  });
});

describe("ShownLinkTexts.keepLabelFree", () => {
  it("clears the label of text that was read and puts in the current title, and reports the cleared (target, original text); text never read, or read by someone else, is untouched", () => {
    const m = new ShownLinkTexts();
    m.record("u1", { free: [[T, "Old"]], custom: [] });
    const wl = (label: string) => ({ type: "wikilink", props: { targetNoteId: T, snapshotTitle: label, label, anchorBlockId: "" } });
    const blocks = [{ type: "paragraph", content: [wl("Old"), wl("Mine")] }];
    const [out, cleared] = m.keepLabelFree(blocks, "u1", [{ id: T, title: "New" }]);
    expect(cleared).toEqual([[T, "Old"]]);
    expect((out[0]!.content as Array<{ props: { label: string; snapshotTitle: string } }>).map(n => [n.props.label, n.props.snapshotTitle])).toEqual([["", "New"], ["Mine", "Mine"]]);
    const [same, none] = m.keepLabelFree(blocks, "u2", [{ id: T, title: "New" }]);
    expect(same).toBe(blocks);
    expect(none).toEqual([]);
  });
});

describe("shownLinkTextsOf", () => {
  const wl = (props: Record<string, string>) => ({ type: "wikilink", props: { snapshotTitle: "", label: "", anchorBlockId: "", ...props } });
  it("link without custom text: the reader sees the target = current title, if not visible = snapshotTitle, if both empty = the URL; custom-text links are listed separately; table cells and child blocks are traversed", () => {
    const blocks = [
      { type: "paragraph", content: [{ type: "text", text: "a ", styles: {} }, wl({ targetNoteId: T.toUpperCase(), snapshotTitle: "Old" }), wl({ targetNoteId: T, label: "Mine" })] },
      { type: "paragraph", content: [wl({ targetNoteId: T2, snapshotTitle: "Hidden snap" })], children: [{ type: "paragraph", content: [wl({ targetNoteId: T2, anchorBlockId: "h1" })] }] },
      { type: "table", content: { type: "tableContent", rows: [{ cells: [[wl({ targetNoteId: T })], { type: "tableCell", content: [wl({ targetNoteId: T, label: "Cell" })] }] }] } },
    ];
    const titles = new Map([[T, "Live"]]);
    const shown = shownLinkTextsOf(blocks, titles);
    expect(shown.free).toEqual([
      [T, "Live"],
      [T2, "Hidden snap"],
      [T2, `/notes/${T2}#b-h1`],
      [T, "Live"],
    ]);
    expect(shown.custom).toEqual([
      [T, "Mine"],
      [T, "Cell"],
    ]);
  });
});
