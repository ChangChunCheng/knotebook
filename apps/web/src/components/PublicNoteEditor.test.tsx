import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT, type PublicLinkDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { ThemeProvider } from "@/theme";
import type { PublicNoteRef } from "@/lib/public-note-ref";
import { PublicNoteEditor } from "./PublicNoteEditor";

// **No QueryClientProvider**: any useNotes call throws immediately.

const PUB = "11111111-1111-4111-8111-111111111111";
const PRIV = "22222222-2222-4222-8222-222222222222";

/** `pubTarget`: the targetNoteId of the first wikilink - lowercase by default; another case passes uppercase (old documents may store uppercase ids). */
function docWith(pubTarget: string = PUB): Y.Doc {
  const doc = new Y.Doc();
  blocksToYXmlFragment(
    BlockNoteEditor.create({ schema: noteSchema }),
    [
      { id: "top", type: "heading", props: { level: 2 }, content: "Top" },
      {
        id: "p1",
        type: "paragraph",
        content: [
          { type: "wikilink", props: { targetNoteId: pubTarget, snapshotTitle: "Snap Pub", label: "", anchorBlockId: "" } },
          " | ",
          { type: "wikilink", props: { targetNoteId: PRIV, snapshotTitle: "Secret Snap", label: "", anchorBlockId: "" } },
          " | ",
          { type: "wikilink", props: { targetNoteId: PRIV, snapshotTitle: "Back to top", label: "", anchorBlockId: "top" } },
        ],
      },
    ] as never,
    doc.getXmlFragment(YDOC_FRAGMENT),
  );
  return doc;
}

function LocationProbe() {
  const l = useLocation();
  return <p data-testid="loc">{`${l.pathname}${l.hash}`}</p>;
}

function renderPublic(publicRef: PublicNoteRef, links: PublicLinkDto[], doc: Y.Doc = docWith()) {
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={["/p/start"]}>
        <PublicNoteEditor doc={doc} publicRef={publicRef} links={links} />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("#269 public page renders wikilinks", () => {
  const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() => new Promise(() => {}));
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    fetchSpy.mockClear();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  for (const publicRef of [{ kind: "token", token: "t".repeat(43) }, { kind: "path", handle: "h", slug: "s" }] as PublicNoteRef[]) {
    it(`${publicRef.kind} shape: public target becomes <a href=/p/...>, non-public becomes plain text, same-note anchor becomes <a href=#b-...>; zero GET /api/notes`, async () => {
      renderPublic(publicRef, [{ id: PUB, title: "Public Title", path: "/p/alice/pub" }]);
      const pub = await screen.findByRole("link", { name: "Public Title" });
      expect(pub).toHaveAttribute("href", "/p/alice/pub");
      expect(screen.getByText("Secret Snap").closest("a")).toBeNull();
      const top = screen.getByRole("link", { name: "Back to top" });
      expect(top).toHaveAttribute("href", "#b-top");
      fireEvent.click(pub);
      await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/p/alice/pub"));
      expect(fetchSpy.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/notes"))).toEqual([]);
    });
  }

  it("document stores an uppercase targetNoteId, payload returns the DB-normalised lowercase id => still links to the public target (doesn't fall back to plain text)", async () => {
    // Must contain a-f: PUB is all digits, so toUpperCase() is unchanged and the case difference can't be detected.
    const hexId = "abcdef12-3456-4789-8abc-def123456789";
    expect(hexId.toUpperCase()).not.toBe(hexId);
    renderPublic({ kind: "token", token: "t".repeat(43) }, [{ id: hexId, title: "Public Title", path: "/p/alice/pub" }], docWith(hexId.toUpperCase()));
    const pub = await screen.findByRole("link", { name: "Public Title" });
    expect(pub).toHaveAttribute("href", "/p/alice/pub");
    expect(screen.queryByText("Snap Pub")).toBeNull();
  });
});

describe("side-by-side public page", () => {
  // Manually triggerable ResizeObserver stand-in (as in collab/columns/layout-extension.test.ts): only fires the observer that observed that element.
  const instances: Array<{ targets: Set<Element>; callback: ResizeObserverCallback }> = [];
  class FakeResizeObserver {
    readonly targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) {
      instances.push(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    instances.length = 0;
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("Y.Doc with one row -> row and two columns drawn, read-only; row width 300 -> the whole row stacks (the layout plugin also works on the public page)", async () => {
    const doc = new Y.Doc();
    blocksToYXmlFragment(
      BlockNoteEditor.create({ schema: noteSchema }),
      [
        { id: "x0", type: "paragraph", content: "x" },
        {
          id: "r",
          type: "columnList",
          children: [
            { id: "rc0", type: "column", props: { width: 1 }, children: [{ id: "a1", type: "paragraph", content: "Left" }] },
            { id: "rc1", type: "column", props: { width: 1 }, children: [{ id: "b1", type: "paragraph", content: "Right" }] },
          ],
        },
      ] as never,
      doc.getXmlFragment(YDOC_FRAGMENT),
    );
    renderPublic({ kind: "token", token: "t".repeat(43) }, [], doc);
    await screen.findByText("Right");
    const rowEl = document.querySelector<HTMLElement>('[data-node-type="columnList"]')!;
    expect(rowEl).not.toBeNull();
    expect(Array.from(rowEl.children).filter((c) => c.matches('[data-node-type="column"]'))).toHaveLength(2);
    expect(rowEl.closest(".bn-editor")).toHaveAttribute("contenteditable", "false");

    Object.defineProperty(rowEl, "clientWidth", { value: 300, configurable: true });
    const observers = instances.filter((ro) => ro.targets.has(rowEl));
    expect(observers).toHaveLength(1);
    act(() => observers[0].callback([{ target: rowEl } as unknown as ResizeObserverEntry], observers[0] as unknown as ResizeObserver));
    await waitFor(() => expect(document.querySelector('[data-node-type="columnList"]')).toHaveAttribute("data-stacked"));
  });
});

describe("#465 public page hands the editor to the heading outline", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("on mount onEditor receives the editor (the document's headings are readable), on unmount it receives null", async () => {
    const onEditor = vi.fn();
    const view = render(
      <ThemeProvider>
        <MemoryRouter>
          <PublicNoteEditor doc={docWith()} publicRef={{ kind: "token", token: "t".repeat(43) }} links={[]} onEditor={onEditor} />
        </MemoryRouter>
      </ThemeProvider>,
    );
    await screen.findByText("Top");
    expect(onEditor).toHaveBeenCalledTimes(1);
    const editor = onEditor.mock.calls[0]![0] as { document: Array<{ id: string; type: string }>; onChange: unknown };
    expect(editor.document[0]).toMatchObject({ id: "top", type: "heading" });
    expect(typeof editor.onChange).toBe("function");
    view.unmount();
    expect(onEditor).toHaveBeenCalledTimes(2);
    expect(onEditor).toHaveBeenLastCalledWith(null);
  });

  it("a new callback on every render from the caller doesn't re-report", async () => {
    const calls: unknown[] = [];
    const doc = docWith();
    const ref = { kind: "token", token: "t".repeat(43) } as const;
    const ui = () => (
      <ThemeProvider>
        <MemoryRouter>
          <PublicNoteEditor doc={doc} publicRef={ref} links={[]} onEditor={(e) => calls.push(e)} />
        </MemoryRouter>
      </ThemeProvider>
    );
    const view = render(ui());
    await screen.findByText("Top");
    view.rerender(ui());
    view.rerender(ui());
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toBeNull();
  });
});
