import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseRef, baseRefOrNull, reEscape, vid, vlabel, vrow, vtarget } from "@/test/version-fixtures";
import { useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT, type VersionDto, type VersionListDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { Toaster, dismissAllToasts } from "@/components/ui/toast";
import { ThemeProvider } from "@/theme";
import { versionListKey } from "@/api/versions";
import { stubLayoutTier } from "@/test/layout-tier";
import { KIND_FILTER_STORAGE_KEY, VersionsProvider, useVersionsController } from "@/lib/versions-context";
import { VersionsSheet } from "./VersionsSheet";

vi.mock("@/lib/use-container-width", () => ({ useContainerWidth: () => widthRef.current }));
const widthRef = vi.hoisted(() => ({ current: 800 }));

const NOTE = "n1";
const LIST = `/api/notes/${NOTE}/versions?limit=50`;
const LIST_MANUAL = `/api/notes/${NOTE}/versions?kind=manual&limit=50`;
const SNAP = (n: number) => `/api/notes/${NOTE}/versions/${n}`;

function b64(blocks: unknown[]): string {
  const doc = new Y.Doc();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PartialBlock generic triple
  blocksToYXmlFragment(BlockNoteEditor.create({ schema: noteSchema }), blocks as any, doc.getXmlFragment(YDOC_FRAGMENT));
  return btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc)));
}
const ver = (seq: number, over: Partial<VersionDto> = {}): VersionDto => ({ id: vid(seq), seq, kind: "auto", name: null, editors: [{ handle: "ann", agentLabel: null, avatar: null }], baseSeq: null, base: baseRefOrNull(over.baseSeq), createdAt: "2026-10-09T00:00:00.000Z", ...over });
const V1 = [{ id: "A", type: "paragraph", content: "甲" }, { id: "B", type: "paragraph", content: "乙" }];
const V2 = [{ id: "A", type: "paragraph", content: "甲改" }, { id: "C", type: "paragraph", content: "丙" }];

function stub(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (!(url in routes)) throw new Error(`unexpected fetch: ${url}`);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(routes[url]) } as Response);
    }),
  );
  return calls;
}
const list = (versions: VersionDto[], nextBefore: number | null = null): VersionListDto => ({
  versions,
  current: { baseSeq: versions[0]?.seq ?? null, base: versions[0] ? { id: versions[0].id, name: versions[0].name, deleted: false } : null, dirty: false, nextSeq: (versions[0]?.seq ?? 0) + 1, autoEnabled: true },
  nextBefore,
});

/** The full page appears only on phones (< 640): the layout tier is pinned to phone. */
function installMatchMedia() {
  stubLayoutTier("phone");
  return () => {
    vi.unstubAllGlobals();
  };
}

function Host({ doc }: { doc: Y.Doc }) {
  const value = useVersionsController({ noteId: NOTE, enabled: true });
  return (
    <VersionsProvider value={value}>
      <button type="button" onClick={value.open}>host-open</button>
      <span data-testid="s-state">{JSON.stringify({ mode: value.mode, preview: value.preview })}</span>
      <span data-testid="s-compare">{JSON.stringify(value.compareRight)}</span>
      {/* Simulates 'show only differences was turned on in the wide layout': the controller's onlyChanges is not reset across breakpoints. */}
      <button type="button" onClick={() => value.setOnlyChanges(true)}>host-only-changes</button>
      <span data-testid="s-only">{String(value.onlyChanges)}</span>
      {value.mode === "sheet" && <VersionsSheet doc={doc} lastEdited={{ byHandle: "ann", agentLabel: null, at: "2026-10-09T00:00:00.000Z" } as never} />}
    </VersionsProvider>
  );
}

/** Simulates the header kebab menu opening the full page - the menu item unmounts once pressed; `fake-menu-trigger` is the returnFocusRef handed to the page (NotePage's kebab button). */
function MenuHost({ doc }: { doc: Y.Doc }) {
  const value = useVersionsController({ noteId: NOTE, enabled: true });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(true);
  return (
    <VersionsProvider value={value}>
      <button ref={triggerRef} type="button">
        fake-menu-trigger
      </button>
      {menuOpen && (
        <button
          type="button"
          onClick={() => {
            setMenuOpen(false);
            value.open();
          }}
        >
          menu-item
        </button>
      )}
      {value.mode === "sheet" && <VersionsSheet doc={doc} lastEdited={null as never} returnFocusRef={triggerRef} />}
    </VersionsProvider>
  );
}

function renderSheet() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Host doc={new Y.Doc()} />
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("host-open"));
  return { queryClient };
}
const sState = () => JSON.parse(screen.getByTestId("s-state").textContent!);
const footerOf = (sheet: HTMLElement) => within(within(sheet).getByTestId("sheet-footer"));

describe("VersionsSheet", () => {
  let restoreMatchMedia: () => void;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    dismissAllToasts();
    widthRef.current = 800;
    restoreMatchMedia = installMatchMedia();
  });
  afterEach(() => {
    restoreMatchMedia();
    vi.unstubAllGlobals();
  });

  it("list step: a full-screen dialog (named Version history), back button, last edit, current state, list and bottom save button", async () => {
    stub({ [LIST]: list([ver(2), ver(1)]) });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    expect(sheet).toHaveClass("fixed", "inset-0");
    expect(within(sheet).getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(within(sheet).getByTestId("sheet-last-edited")).toHaveTextContent("ann");
    expect(await within(sheet).findByText("Based on amber-bison (0002aaa) · no changes")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: vrow(1) })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Save current version" })).toBeInTheDocument();
  });

  it("list step: the Back and filter buttons are big enough on phones (Back 44 high, filter 36); the preview step's List button is 44 too", async () => {
    stub({ [LIST]: list([ver(1)]), [SNAP(1)]: { id: vid(1), seq: 1, ydoc: b64(V1) } });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    expect(within(sheet).getByRole("button", { name: "Back" })).toHaveClass("h-11");
    const filter = within(sheet).getByRole("group", { name: "Filter versions" });
    for (const button of within(filter).getAllByRole("button")) expect(button).toHaveClass("max-sm:h-9");
    fireEvent.click(await within(sheet).findByRole("button", { name: vrow(1) }));
    expect(await within(sheet).findByRole("button", { name: /^List/ })).toHaveClass("h-11");
  });

  it("list step: a row has an editor avatar group and the accessible name is unchanged", async () => {
    const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
    stub({ [LIST]: list([ver(2, { editors: [{ handle: "alice", agentLabel: "Claude", avatar: { id: ID, v: 2 } }, { handle: "bob", agentLabel: null, avatar: null }] }), ver(1)]) });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    const row = await within(sheet).findByRole("button", { name: vrow(2) });
    expect(row.querySelectorAll("img")).toHaveLength(1);
    expect(row.querySelectorAll("[data-editor-avatar]")).toHaveLength(2);
    expect(row).toHaveTextContent("alice (Claude), bob ·");
  });

  it("preview step: an editor avatar group sits beside the header summary (the text summary is unchanged)", async () => {
    const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
    stub({ [LIST]: list([ver(2, { editors: [{ handle: "alice", agentLabel: null, avatar: { id: ID, v: 2 } }] }), ver(1)]) });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: vrow(2) }));
    const compare = await within(sheet).findByTestId("sheet-compare-row");
    const header = compare.parentElement!;
    expect(header.querySelectorAll("[data-editor-avatar]")).toHaveLength(1);
    expect(header.querySelector("img")).not.toBeNull();
    expect(header).toHaveTextContent("· alice");
  });

  it("clicking a row -> preview step: title 'List - name (short id)', a single-column diff (no side-by-side button; still single column at container width 1600), bottom Previous | Apply name (short id) | Next", async () => {
    widthRef.current = 1600;
    stub({ [LIST]: list([ver(2), ver(1)]), [SNAP(2)]: { id: vid(2), seq: 2, ydoc: b64(V2) }, [SNAP(1)]: { id: vid(1), seq: 1, ydoc: b64(V1) } });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: vrow(2) }));
    expect(await within(sheet).findByTestId("diff-single")).toBeInTheDocument();
    expect(within(sheet).queryByTestId("diff-split")).not.toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: new RegExp(`^List · ${reEscape(vlabel(2))}`) })).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Side by side" })).not.toBeInTheDocument();
    const footer = footerOf(sheet);
    expect(footer.getByRole("button", { name: "Older version" })).toBeEnabled();
    expect(footer.getByRole("button", { name: `Apply ${vlabel(2)}` })).toBeEnabled();
    expect(footer.getByRole("button", { name: "Newer version" })).toBeDisabled();
  });

  it("preview step header row 2 is a left/right pair of dropdowns (left seq 2 -> right Current state) plus show-only-differences; choosing seq 1 on the right -> compareRight = seq 1; the bottom Older version button changes only the left and the right stays", async () => {
    stub({ [LIST]: list([ver(2), ver(1)]), [SNAP(2)]: { id: vid(2), seq: 2, ydoc: b64(V2) }, [SNAP(1)]: { id: vid(1), seq: 1, ydoc: b64(V1) } });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: vrow(2) }));
    const row = within(await within(sheet).findByTestId("sheet-compare-row"));
    const left = row.getByRole("button", { name: "Left side" });
    const right = row.getByRole("button", { name: "Right side" });
    await waitFor(() => expect(left).toHaveTextContent(vlabel(2)));
    expect(right).toHaveTextContent("Current state");
    expect(row.getByText("→")).toHaveAttribute("aria-hidden", "true");
    // The full page (touch has no hover, so title is not visible) keeps the text button, not the banner's icon button.
    const only = row.getByRole("button", { name: "Only changes" });
    expect(only).toHaveTextContent("Only changes");
    expect(only.querySelector("svg")).toBeNull();
    // The full page is always single column (forceSingle): the preview area has no column header row, so the only dropdowns are the pair in row 2 (the same at width 800 >= 720).
    await within(sheet).findByTestId("diff-single");
    expect(within(sheet).queryByTestId("diff-split-head")).toBeNull();
    expect(within(sheet).getAllByRole("button", { name: "Left side" })).toHaveLength(1);
    expect(within(sheet).getAllByRole("button", { name: "Right side" })).toHaveLength(1);
    expect(screen.getByTestId("s-compare")).toHaveTextContent('"current"');
    expect(within(sheet).queryByText("Compare with")).not.toBeInTheDocument();
    fireEvent.pointerDown(right, { button: 0, ctrlKey: false });
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitemradio", { name: vlabel(1) }));
    expect(screen.getByTestId("s-compare")).toHaveTextContent(JSON.stringify(vtarget(1)));
    await waitFor(() => expect(row.getByRole("button", { name: "Right side" })).toHaveTextContent(vlabel(1)));
    fireEvent.click(footerOf(sheet).getByRole("button", { name: "Older version" }));
    await waitFor(() => expect(sState().preview).toEqual(vtarget(1)));
    expect(screen.getByTestId("s-compare")).toHaveTextContent(JSON.stringify(vtarget(1)));
  });

  it("show only differences: turned on in the wide layout first -> the full page's preview-step switch shows on, and one press turns it off", async () => {
    stub({ [LIST]: list([ver(2), ver(1)]), [SNAP(2)]: { id: vid(2), seq: 2, ydoc: b64(V2) }, [SNAP(1)]: { id: vid(1), seq: 1, ydoc: b64(V1) } });
    renderSheet();
    fireEvent.click(screen.getByText("host-only-changes"));
    expect(screen.getByTestId("s-only")).toHaveTextContent("true");
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: vrow(2) }));
    const toggle = await within(sheet).findByRole("button", { name: "Only changes" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(screen.getByTestId("s-only")).toHaveTextContent("false");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("after closing the full page focus returns to the element from before opening (a controlled Dialog has no Trigger, so Radix does not restore it by itself)", async () => {
    stub({ [LIST]: list([ver(1)]) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Host doc={new Y.Doc()} />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const opener = screen.getByText("host-open");
    opener.focus();
    expect(document.activeElement).toBe(opener);
    fireEvent.click(opener);
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("the element focused before opening (a kebab menu item) is unmounted before closing -> after closing the full page focus falls back to returnFocusRef (the header kebab button)", async () => {
    stub({ [LIST]: list([ver(1)]) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MenuHost doc={new Y.Doc()} />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const item = screen.getByText("menu-item");
    item.focus();
    expect(document.activeElement).toBe(item);
    // Same batch: opening the full page plus the menu item unmounting (like NoteMenu's setMenuOpen(false) + versions.open()). When the full page mounts, what was recorded is the menu item.
    fireEvent.click(item);
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    expect(screen.queryByText("menu-item")).not.toBeInTheDocument();
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Version history" })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "fake-menu-trigger" })));
  });

  it("focus is on body when the full page opens -> after closing it falls back to returnFocusRef (the kebab button), not body", async () => {
    stub({ [LIST]: list([ver(1)]) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MenuHost doc={new Y.Doc()} />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    // fireEvent.click does not move focus: activeElement is still body when the full page mounts.
    fireEvent.click(screen.getByText("menu-item"));
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Version history" })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "fake-menu-trigger" })));
  });

  it("preview step header row 2 (left/right dropdowns + show only differences) may wrap (flex-wrap; that it does not overflow at 320 px is inferred from the classes, real-browser measurement is left to e2e)", async () => {
    stub({ [LIST]: list([ver(2), ver(1)]), [SNAP(2)]: { id: vid(2), seq: 2, ydoc: b64(V2) }, [SNAP(1)]: { id: vid(1), seq: 1, ydoc: b64(V1) } });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: vrow(2) }));
    expect(await within(sheet).findByTestId("sheet-compare-row")).toHaveClass("flex-wrap");
  });

  it("Previous / Next: move between seqs (the preview target carries that row's name, #272), and Previous is disabled on the oldest version", async () => {
    stub({ [LIST]: list([ver(2), ver(1, { kind: "manual", name: "初稿" })]), [SNAP(2)]: { id: vid(2), seq: 2, ydoc: b64(V2) }, [SNAP(1)]: { id: vid(1), seq: 1, ydoc: b64(V1) } });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: vrow(2) }));
    fireEvent.click(footerOf(sheet).getByRole("button", { name: "Older version" }));
    await waitFor(() => expect(sState().preview).toEqual(vtarget(1, "初稿")));
    expect(footerOf(sheet).getByRole("button", { name: "Older version" })).toBeDisabled();
    fireEvent.click(footerOf(sheet).getByRole("button", { name: "Newer version" }));
    await waitFor(() => expect(sState().preview).toEqual(vtarget(2)));
  });

  it("narrow window: the previewed version is renamed -> the header List button and the apply button switch to the new name at once (the list row takes precedence over the name remembered at selection)", async () => {
    stub({ [LIST]: list([ver(2), ver(1)]), [SNAP(2)]: { id: vid(2), seq: 2, ydoc: b64(V2) } });
    const { queryClient } = renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: vrow(2) }));
    expect(await within(sheet).findByRole("button", { name: new RegExp(`^List · ${reEscape(vlabel(2))}`) })).toBeInTheDocument();
    act(() => {
      queryClient.setQueryData(versionListKey(NOTE, "all"), {
        pages: [list([{ ...ver(2), kind: "manual" as const, name: "改好的名字" }, ver(1)])],
        pageParams: [undefined],
      });
    });
    expect(await within(sheet).findByRole("button", { name: new RegExp(`^List · ${reEscape(vlabel(2, "改好的名字"))}`) })).toBeInTheDocument();
    expect(footerOf(sheet).getByRole("button", { name: `Apply ${vlabel(2, "改好的名字")}` })).toBeEnabled();
  });

  it("List back button -> returns to the list step and leaves the preview; Back button -> closes the full page (mode=null)", async () => {
    stub({ [LIST]: list([ver(1)]), [SNAP(1)]: { id: vid(1), seq: 1, ydoc: b64(V1) } });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: vrow(1) }));
    fireEvent.click(await within(sheet).findByRole("button", { name: /^List/ }));
    expect(sState().preview).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(sState()).toEqual({ mode: null, preview: null }));
    expect(screen.queryByRole("dialog", { name: "Version history" })).not.toBeInTheDocument();
  });

  it("closing with pointerdown + click outside the full page also stops the preview (no orphan preview left with mode=null)", async () => {
    stub({ [LIST]: list([ver(1)]), [SNAP(1)]: { id: vid(1), seq: 1, ydoc: b64(V1) } });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: vrow(1) }));
    await within(sheet).findByRole("button", { name: /^List/ });
    expect(sState()).toEqual({ mode: "sheet", preview: vtarget(1) });
    // Radix defers a left-button "click outside" until click (deferPointerDownOutside), so send pointerdown + click as a pair.
    const outside = screen.getByTestId("s-state");
    fireEvent.pointerDown(outside, { button: 0 });
    fireEvent.click(outside, { button: 0 });
    await waitFor(() => expect(sState()).toEqual({ mode: null, preview: null }));
  });

  it("Esc: the preview step goes back to the list (preventDefault, the full page stays), and a press on the list step closes the full page (also preventDefault)", async () => {
    stub({ [LIST]: list([ver(1)]), [SNAP(1)]: { id: vid(1), seq: 1, ydoc: b64(V1) } });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: vrow(1) }));
    const listButton = await within(sheet).findByRole("button", { name: /^List/ });
    // fireEvent returning false means the event was preventDefault-ed (NotePage's Esc listener yields on defaultPrevented).
    expect(fireEvent.keyDown(listButton, { key: "Escape" })).toBe(false);
    await waitFor(() => expect(sState()).toEqual({ mode: "sheet", preview: null }));
    expect(screen.getByRole("dialog", { name: "Version history" })).toBeInTheDocument();
    expect(fireEvent.keyDown(within(sheet).getByRole("button", { name: "Back" }), { key: "Escape" })).toBe(false);
    await waitFor(() => expect(sState()).toEqual({ mode: null, preview: null }));
  });

  it("preview step: pressing 'Apply name (short id)' goes through requestApply (refetches current first, then POSTs apply directly when not dirty)", async () => {
    const calls = stub({
      [LIST]: list([ver(1)]),
      [SNAP(1)]: { id: vid(1), seq: 1, ydoc: b64(V1) },
      [`/api/notes/${NOTE}/versions?limit=1`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1/apply`]: { current: { baseSeq: 1, base: baseRef(1), dirty: false, nextSeq: 2, autoEnabled: true } },
    });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: vrow(1) }));
    fireEvent.click(footerOf(sheet).getByRole("button", { name: `Apply ${vlabel(1)}` }));
    await waitFor(() => expect(calls).toContain(`/api/notes/${NOTE}/versions/1/apply`));
    expect(calls.indexOf(`/api/notes/${NOTE}/versions?limit=1`)).toBeLessThan(calls.indexOf(`/api/notes/${NOTE}/versions/1/apply`));
    await waitFor(() => expect(sState()).toEqual({ mode: "sheet", preview: null }));
  });

  it("filter (#258): between the current state and the list on the list step there is All / Manual only; pressing it requests kind=manual; only auto versions have the Auto-save pill; an empty state shows when nothing matches", async () => {
    stub({
      [LIST]: list([ver(3, { kind: "manual", name: "里程碑" }), ver(2), ver(1)]),
      [LIST_MANUAL]: { ...list([ver(3, { kind: "manual", name: "里程碑" })]), current: list([ver(3)]).current },
    });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    const row2 = await within(sheet).findByRole("button", { name: vrow(2) });
    expect(within(row2).getByTestId("auto-badge")).toHaveTextContent("Auto-saved");
    expect(within(within(sheet).getByRole("button", { name: vrow(3, "里程碑") })).queryByTestId("auto-badge")).not.toBeInTheDocument();
    const group = within(sheet).getByRole("group", { name: "Filter versions" });
    const order = [within(sheet).getByTestId("sheet-current"), group, within(sheet).getByRole("list")];
    for (let i = 1; i < order.length; i += 1) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(group).getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(group).getByRole("button", { name: "Manual only" }));
    expect(within(group).getByRole("button", { name: "Manual only" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(within(sheet).queryByRole("button", { name: vrow(2) })).not.toBeInTheDocument());
    expect(await within(sheet).findByRole("button", { name: vrow(3, "里程碑") })).toBeInTheDocument();
    expect(window.localStorage.getItem(KIND_FILTER_STORAGE_KEY)).toBe("manual");
  });

  it("filter (#258): manual only with no match -> a one-line grey empty state; the current state is still shown", async () => {
    window.localStorage.setItem(KIND_FILTER_STORAGE_KEY, "manual");
    stub({ [LIST_MANUAL]: { ...list([]), current: { baseSeq: 2, base: baseRef(2), dirty: true, nextSeq: 3, autoEnabled: true } } });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    expect(await within(sheet).findByTestId("versions-filter-empty")).toHaveTextContent("No manually saved versions");
    expect(within(sheet).getByText(`Based on ${vlabel(2)} · unsaved changes`)).toBeInTheDocument();
  });
});
