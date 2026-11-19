import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { BlockNoteEditor } from "@blocknote/core";
import { canonicalNotePath, type NoteDto, type PublicLinkDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { noteSchema } from "@/collab/schema";
import { BlockAnchorContext, type BlockAnchorApi } from "@/hooks/block-anchor-context";
import { OWNER_PERMS } from "@/test/fixtures";
import { WikilinkContext, type WikilinkMode } from "./context";
import { insertWikilink, WikilinkInline } from "./spec";

describe("export (headless BlockNoteEditor)", () => {
  const blocks = (props: Record<string, string>) => [
    { type: "paragraph" as const, content: ["See ", { type: "wikilink" as const, props: { targetNoteId: "note-1", snapshotTitle: "Meeting Notes", label: "", anchorBlockId: "", ...props } }, " now."] },
  ];
  it("blocksToHTMLLossy: <a href=/notes/<id>>, the text label first and otherwise snapshotTitle; the anchor goes into href; the outer data-* attributes are carried over", () => {
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    const plain = editor.blocksToHTMLLossy(blocks({}));
    expect(plain).toContain('data-inline-content-type="wikilink"');
    expect(plain).toContain('<a href="/notes/note-1">Meeting Notes</a>');
    expect(plain).not.toContain("[[");
    const labelled = editor.blocksToHTMLLossy(blocks({ label: "L", anchorBlockId: "b1" }));
    expect(labelled).toContain('<a href="/notes/note-1#b-b1">L</a>');
  });
  it("blocksToMarkdownLossy: [text](/notes/<id>); when the display text is empty it falls back to href (so the link never disappears from the export)", () => {
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    expect(editor.blocksToMarkdownLossy(blocks({}))).toContain("[Meeting Notes](/notes/note-1)");
    // With an all-empty label the link text equals the href: HTML is still an `<a>`; markdown goes through `formatLink` in BlockNote 0.52.1's htmlToMarkdown (which emits a bare URL when the text equals the URL)
    // and comes out as `/notes/note-1`; the text is still in the export.
    expect(editor.blocksToHTMLLossy(blocks({ snapshotTitle: "" }))).toContain('<a href="/notes/note-1">/notes/note-1</a>');
    expect(editor.blocksToMarkdownLossy(blocks({ snapshotTitle: "" }))).toContain("See /notes/note-1 now.");
  });
});

const TARGET: NoteDto = {
  id: "22222222-2222-2222-2222-222222222222",
  title: "Renamed In The Meantime",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "renamed-in-the-meantime",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

function LocationProbe() {
  const l = useLocation();
  return <p data-testid="loc">{`${l.pathname}${l.search}${l.hash}`}</p>;
}
const loc = () => screen.getByTestId("loc").textContent;

interface RenderOpts {
  props: { targetNoteId: string; snapshotTitle?: string; label?: string; anchorBlockId?: string };
  queryClient?: QueryClient;
  editor?: Record<string, unknown>;
  mode?: WikilinkMode;
  anchors?: Partial<BlockAnchorApi>;
}

function renderWikilink(opts: RenderOpts) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stand-in: the component reads only isEditable / getBlock; BlockNoteEditor<any,any,any> per repo convention
  const editor = (opts.editor ?? { isEditable: false }) as unknown as BlockNoteEditor<any, any, any>;
  const anchors: BlockAnchorApi = { currentNoteId: null, requestAnchor: vi.fn(), scrollToTop: vi.fn(), ...opts.anchors };
  const tree = (
    <MemoryRouter initialEntries={["/start?x=1"]}>
      <BlockAnchorContext.Provider value={anchors}>
        <WikilinkContext.Provider value={opts.mode ?? { mode: "member" }}>
          <WikilinkInline
            inlineContent={{ type: "wikilink", props: { snapshotTitle: "", label: "", anchorBlockId: "", ...opts.props }, content: undefined }}
            updateInlineContent={() => {}}
            editor={editor}
            contentRef={() => {}}
          />
        </WikilinkContext.Provider>
      </BlockAnchorContext.Provider>
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
      <Toaster />
    </MemoryRouter>
  );
  render(opts.queryClient ? <QueryClientProvider client={opts.queryClient}>{tree}</QueryClientProvider> : tree);
  return { anchors };
}

/** Editable editor stand-in with `focus` (pulls focus back when the toolbar closes). */
const EDITABLE_STUB = { isEditable: true, focus: () => {} };

const pendingClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const loadedClient = (notes: NoteDto[]) => {
  const qc = pendingClient();
  qc.setQueryData(["notes"], notes);
  return qc;
};

describe("MemberWikilink", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    dismissAllToasts();
  });

  it("list not arrived: <a href=/notes/<id>[#b-...]>, the text label first and otherwise snapshotTitle; live-link style; a plain click navigates in the same tab", () => {
    renderWikilink({ queryClient: pendingClient(), props: { targetNoteId: TARGET.id, snapshotTitle: "Snap", anchorBlockId: "b1" } });
    const link = screen.getByRole("link", { name: "Snap" });
    expect(link).toHaveAttribute("href", `/notes/${TARGET.id}#b-b1`);
    expect(link).toHaveClass("text-(--color-brand)", "underline");
    expect(link).not.toHaveClass("border-dashed");
    fireEvent.click(link);
    expect(loc()).toBe(`/notes/${TARGET.id}#b-b1`);
  });

  it("live links and broken links both carry the tour target attribute (the feature tour falls back to it when the [[ menu is not live)", () => {
    renderWikilink({ queryClient: pendingClient(), props: { targetNoteId: TARGET.id, snapshotTitle: "Snap" } });
    expect(screen.getByRole("link", { name: "Snap" })).toHaveAttribute("data-kb-tour-target", "wikilink");
    cleanup();
    renderWikilink({ queryClient: loadedClient([]), props: { targetNoteId: "44444444-4444-4444-4444-444444444444", snapshotTitle: "Deleted Note" } });
    expect(screen.getByText("Deleted Note")).toHaveAttribute("data-kb-tour-target", "wikilink");
  });

  it("list query failure (retries exhausted, isPending=false but data still undefined): the same state as the list not having arrived, not a broken link, and no invented note-does-not-exist", async () => {
    // Overrides the never-resolving stub from beforeEach: here the query must really reach the error terminal state (isPending false, data never received).
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))));
    const queryClient = pendingClient();
    renderWikilink({ queryClient, props: { targetNoteId: TARGET.id, snapshotTitle: "Snap" } });
    await waitFor(() => expect(queryClient.getQueryState(["notes"])?.status).toBe("error"));
    const link = screen.getByRole("link", { name: "Snap" });
    expect(link).toHaveAttribute("href", `/notes/${TARGET.id}`);
    expect(link).toHaveClass("text-(--color-brand)", "underline");
    expect(link).not.toHaveClass("border-dashed");
    fireEvent.click(link);
    expect(loc()).toBe(`/notes/${TARGET.id}`);
    expect(screen.queryByText("This linked note no longer exists.")).not.toBeInTheDocument();
  });

  it("hit: the text is the label (if any) or the current title; href is canonical plus the anchor; a click navigates to canonical", () => {
    renderWikilink({ queryClient: loadedClient([TARGET]), props: { targetNoteId: TARGET.id, snapshotTitle: "Old", anchorBlockId: "h2" } });
    const link = screen.getByRole("link", { name: TARGET.title });
    expect(link).toHaveAttribute("href", `${canonicalNotePath(TARGET)}#b-h2`);
    fireEvent.click(link);
    expect(loc()).toBe(`${canonicalNotePath(TARGET)}#b-h2`);
  });

  it("hit with a label: shows the label, not the current title", () => {
    renderWikilink({ queryClient: loadedClient([TARGET]), props: { targetNoteId: TARGET.id, snapshotTitle: "Old", label: "Custom" } });
    expect(screen.getByRole("link", { name: "Custom" })).toHaveAttribute("href", canonicalNotePath(TARGET));
    expect(screen.queryByText(TARGET.title)).not.toBeInTheDocument();
  });

  it("#269: the document stores an uppercase targetNoteId and the list has a lowercase id => hit (live link, current title), not a broken link", () => {
    // Must contain a-f: TARGET.id is all digits and toUpperCase() leaves it unchanged, so case would not be tested.
    const hex: NoteDto = { ...TARGET, id: "abcdef12-3456-4789-8abc-def123456789" };
    expect(hex.id.toUpperCase()).not.toBe(hex.id);
    renderWikilink({ queryClient: loadedClient([hex]), props: { targetNoteId: hex.id.toUpperCase(), snapshotTitle: "Old" } });
    expect(screen.getByRole("link", { name: hex.title })).toHaveAttribute("href", canonicalNotePath(hex));
    expect(screen.queryByText("Old")).not.toBeInTheDocument();
  });

  it("broken link (the list arrived but lacks this id): a <span> in broken-link style (not a link), label or snapshotTitle; a click only toasts", () => {
    renderWikilink({ queryClient: loadedClient([]), props: { targetNoteId: "44444444-4444-4444-4444-444444444444", snapshotTitle: "Deleted Note" } });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    const span = screen.getByText("Deleted Note");
    expect(span).toHaveClass("border-dashed", "text-muted-foreground");
    expect(span).not.toHaveClass("text-(--color-brand)");
    fireEvent.click(span);
    expect(screen.getByText("This linked note no longer exists.")).toBeInTheDocument();
    expect(loc()).toBe("/start?x=1");
  });

  it("modifier keys (Ctrl / Meta / Shift / Alt) and non-left-button clicks: not preventDefault-ed and no navigation (left to the browser to open a new tab)", () => {
    renderWikilink({ queryClient: loadedClient([TARGET]), props: { targetNoteId: TARGET.id } });
    const link = screen.getByRole("link", { name: TARGET.title });
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(fireEvent.click(link, init), JSON.stringify(init)).toBe(true);
      expect(loc()).toBe("/start?x=1");
    }
  });

  it("a plain click when editable: same as read-only - preventDefault and same-tab navigation (the toolbar now opens by hover / long-press, see WikilinkToolbar.test.tsx)", () => {
    renderWikilink({ queryClient: loadedClient([TARGET]), props: { targetNoteId: TARGET.id }, editor: EDITABLE_STUB });
    const link = screen.getByRole("link", { name: TARGET.title });
    expect(fireEvent.click(link)).toBe(false);
    expect(loc()).toBe(canonicalNotePath(TARGET));
  });

  it("read-only: a contextmenu during a touch press is not intercepted (keeping the system long-press menu) and a long-press does not block the following click", async () => {
    renderWikilink({ queryClient: loadedClient([TARGET]), props: { targetNoteId: TARGET.id } });
    const link = screen.getByRole("link", { name: TARGET.title });
    fireEvent.pointerDown(link, { pointerType: "touch", clientX: 1, clientY: 1 });
    expect(fireEvent.contextMenu(link)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    fireEvent.pointerUp(link, { pointerType: "touch" });
    fireEvent.click(link);
    expect(loc()).toBe(canonicalNotePath(TARGET));
  });

  it("when editable the <a> is not natively draggable (draggable=false: dragged text/html dropped back into the editor would become a plain link); read-only does not set draggable", () => {
    renderWikilink({ queryClient: loadedClient([TARGET]), props: { targetNoteId: TARGET.id }, editor: EDITABLE_STUB });
    expect(screen.getByRole("link", { name: TARGET.title })).toHaveAttribute("draggable", "false");
    cleanup();
    renderWikilink({ queryClient: loadedClient([TARGET]), props: { targetNoteId: TARGET.id } });
    expect(screen.getByRole("link", { name: TARGET.title })).not.toHaveAttribute("draggable");
  });

  it("same note plus anchor: requestAnchor(id) and only the hash changes (pathname / search unchanged), no page change", () => {
    const { anchors } = renderWikilink({
      queryClient: loadedClient([TARGET]),
      props: { targetNoteId: TARGET.id, anchorBlockId: "b9" },
      anchors: { currentNoteId: TARGET.id },
    });
    fireEvent.click(screen.getByRole("link"));
    expect(anchors.requestAnchor).toHaveBeenCalledWith("b9");
    expect(loc()).toBe("/start?x=1#b-b9");
  });

  it("same note without anchor: scrollToTop and the URL is unchanged", () => {
    const { anchors } = renderWikilink({ queryClient: loadedClient([TARGET]), props: { targetNoteId: TARGET.id }, anchors: { currentNoteId: TARGET.id } });
    fireEvent.click(screen.getByRole("link"));
    expect(anchors.scrollToTop).toHaveBeenCalledTimes(1);
    expect(loc()).toBe("/start?x=1");
  });
});

describe("PublicWikilink (does not call useNotes)", () => {
  const links = (list: PublicLinkDto[]): WikilinkMode => ({ mode: "public", links: new Map(list.map((l) => [l.id, l])) });
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders without a QueryClientProvider (does not call useNotes) with zero fetches; a target with a custom public URL becomes <a href=/p/...[#b-...]> and the label wins", () => {
    const fetchSpy = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchSpy);
    renderWikilink({ mode: links([{ id: TARGET.id, title: "Public Title", path: "/p/tester/pub" }]), props: { targetNoteId: TARGET.id, anchorBlockId: "x1" } });
    const link = screen.getByRole("link", { name: "Public Title" });
    expect(link).toHaveAttribute("href", "/p/tester/pub#b-x1");
    fireEvent.click(link);
    expect(loc()).toBe("/p/tester/pub#b-x1");
    expect(fetchSpy).not.toHaveBeenCalled();
    cleanup();
    renderWikilink({ mode: links([{ id: TARGET.id, title: "Public Title", path: "/p/tester/pub" }]), props: { targetNoteId: TARGET.id, label: "L" } });
    expect(screen.getByRole("link", { name: "L" })).toHaveAttribute("href", "/p/tester/pub");
    expect(screen.queryByText("Public Title")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("not in links (non-public, token form only, deleted): a plain-text <span> (not clickable, no link style)", () => {
    renderWikilink({ mode: links([]), props: { targetNoteId: TARGET.id, snapshotTitle: "Snap", label: "Lab" } });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Lab")).not.toHaveClass("underline");
  });

  it("same-note anchor: not in links but the block is on this page => <a href=#b-...>, and a click does requestAnchor and only changes the hash; the block is not on this page => plain text", () => {
    const { anchors } = renderWikilink({
      mode: links([]),
      props: { targetNoteId: TARGET.id, snapshotTitle: "Here", anchorBlockId: "b1" },
      editor: { isEditable: false, getBlock: (id: string) => (id === "b1" ? { id } : undefined) },
    });
    const link = screen.getByRole("link", { name: "Here" });
    expect(link).toHaveAttribute("href", "#b-b1");
    fireEvent.click(link);
    expect(anchors.requestAnchor).toHaveBeenCalledWith("b1");
    expect(loc()).toBe("/start?x=1#b-b1");
    // Counter-case: an anchor pointing at a block this page lacks (the stub's getBlock returns undefined for "zz") => plain text, not an <a href="#b-zz"> that cannot scroll.
    cleanup();
    renderWikilink({
      mode: links([]),
      props: { targetNoteId: TARGET.id, snapshotTitle: "Elsewhere", anchorBlockId: "zz" },
      editor: { isEditable: false, getBlock: (id: string) => (id === "b1" ? { id } : undefined) },
    });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Elsewhere")).not.toHaveClass("underline");
  });
});

describe("insertWikilink", () => {
  it("new props default to the empty string; the caller may pass label / anchorBlockId; a trailing space is added", () => {
    const insertInlineContent = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test stand-in needs only insertInlineContent
    const editorStub = { insertInlineContent } as any;
    insertWikilink(editorStub, { targetNoteId: "n1", snapshotTitle: "Meeting Notes" });
    expect(insertInlineContent).toHaveBeenLastCalledWith([
      { type: "wikilink", props: { targetNoteId: "n1", snapshotTitle: "Meeting Notes", label: "", anchorBlockId: "" } },
      " ",
    ]);
    insertWikilink(editorStub, { targetNoteId: "n1", snapshotTitle: "M", label: "L", anchorBlockId: "b" });
    expect(insertInlineContent).toHaveBeenLastCalledWith([{ type: "wikilink", props: { targetNoteId: "n1", snapshotTitle: "M", label: "L", anchorBlockId: "b" } }, " "]);
  });
});
