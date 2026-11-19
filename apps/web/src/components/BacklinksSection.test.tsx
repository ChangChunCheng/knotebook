import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { canonicalNotePath, type BacklinkDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { BACKLINKS_SCROLL_ROW, SIDEBAR_ROW_HEIGHT } from "@/components/ui/rows";
import { stubLayoutTier } from "@/test/layout-tier";
import { BacklinksSection } from "./BacklinksSection";

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

function mockFetch(backlinks: BacklinkDto[]) {
  return vi.fn(() =>
    Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ backlinks }) })),
  );
}

function renderSection(noteId: string | undefined) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <BacklinksSection noteId={noteId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

const NOTE_ID = "11111111-1111-1111-1111-111111111111";

const BACKLINKS: BacklinkDto[] = [
  { id: "22222222-2222-2222-2222-222222222222", title: "Alpha", slug: "alpha", ownerHandle: "tester", groupId: null },
  // #175: source is a group note (no personal owner): the link goes to `/g/<groupId>/<slug>`.
  {
    id: "33333333-3333-3333-3333-333333333333",
    title: "Beta",
    slug: "beta",
    ownerHandle: null,
    groupId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  },
];

describe("BacklinksSection", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("0 backlinks -> the block stays and shows the empty-state text (no longer hidden entirely)", async () => {
    vi.stubGlobal("fetch", mockFetch([]));

    const { container, queryClient } = renderSection(NOTE_ID);

    // Wait for the query to settle (success) before asserting: waiting only for fetch to be called passes while still pending
    // and misses the behaviour after getting 0 notes.
    await waitFor(() =>
      expect(queryClient.getQueryState(["backlinks", NOTE_ID])?.status).toBe("success"),
    );
    expect(screen.getByText("No mentions yet")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("border-t");
  });

  it("noteId not yet known (note still loading) -> no request; the block keeps an empty row and shows no text", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { container } = renderSection(undefined);

    expect(fetchSpy).not.toHaveBeenCalled();
    // The block stays (layout height doesn't jump), but while the count is unknown it must not say "no notes mention this", which would be a lie.
    expect(container.firstElementChild).not.toBeNull();
    expect(screen.queryByText("No mentions yet")).not.toBeInTheDocument();
    expect(container.textContent).toBe("");
  });

  it("query fails -> likewise only an empty row, no error shown and no false 0 count", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(fakeResponse({ ok: false, status: 500 }))),
    );

    const { container, queryClient } = renderSection(NOTE_ID);

    await waitFor(() =>
      expect(queryClient.getQueryState(["backlinks", NOTE_ID])?.status).toBe("error"),
    );
    expect(screen.queryByText("No mentions yet")).not.toBeInTheDocument();
    expect(container.textContent).toBe("");
  });

  it("phone: 0 notes, query pending and query failed all render no row", async () => {
    stubLayoutTier("phone");
    vi.stubGlobal("fetch", mockFetch([]));
    const empty = renderSection(NOTE_ID);
    await waitFor(() => expect(empty.queryClient.getQueryState(["backlinks", NOTE_ID])?.status).toBe("success"));
    expect(empty.container).toBeEmptyDOMElement();
    empty.unmount();

    vi.stubGlobal("fetch", vi.fn());
    const unknown = renderSection(undefined);
    expect(unknown.container).toBeEmptyDOMElement();
    unknown.unmount();

    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(fakeResponse({ ok: false, status: 500 }))));
    const failed = renderSection(NOTE_ID);
    await waitFor(() => expect(failed.queryClient.getQueryState(["backlinks", NOTE_ID])?.status).toBe("error"));
    expect(failed.container).toBeEmptyDOMElement();
  });

  it("phone: with mentions, title and chips show as usual", async () => {
    stubLayoutTier("phone");
    vi.stubGlobal("fetch", mockFetch(BACKLINKS));
    renderSection(NOTE_ID);
    expect(await screen.findByText("Mentioned in 2 notes")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Alpha" })).toBeInTheDocument();
  });

  it.each(["overlay", "docked"] as const)("%s: 0 notes still shows the empty-state text", async (tier) => {
    stubLayoutTier(tier);
    vi.stubGlobal("fetch", mockFetch([]));
    renderSection(NOTE_ID);
    expect(await screen.findByText("No mentions yet")).toBeInTheDocument();
  });

  it("N notes -> title includes the count; each title is rendered with the correct canonicalNotePath href", async () => {
    const fetchSpy = mockFetch(BACKLINKS);
    vi.stubGlobal("fetch", fetchSpy);

    renderSection(NOTE_ID);

    expect(await screen.findByText("Mentioned in 2 notes")).toBeInTheDocument();

    // Pin the endpoint path: verify not just that fetch was called but that it was this note's backlinks endpoint.
    expect(fetchSpy).toHaveBeenCalledWith(`/api/notes/${NOTE_ID}/backlinks`, expect.anything());

    expect(screen.getByRole("link", { name: "Alpha" })).toHaveAttribute("href", canonicalNotePath(BACKLINKS[0]));
    expect(screen.getByRole("link", { name: "Beta" })).toHaveAttribute("href", canonicalNotePath(BACKLINKS[1]));

    // Literal anchor: canonicalNotePath's own behaviour is tested elsewhere (shared, NoteList); one literal pinned here keeps this test
    // from silently losing meaning if canonicalNotePath changes (same assertion shape as NoteList.test.tsx).
    expect(canonicalNotePath(BACKLINKS[0])).toBe("/n/tester/alpha");
    // #175: a chip from a group source links to the `/g/` shape (BacklinksSection reads `BacklinkDto.groupId`).
    expect(screen.getByRole("link", { name: "Beta" })).toHaveAttribute(
      "href",
      "/g/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/beta",
    );
  });

  it("singular (1 note) uses i18next's _one branch", async () => {
    vi.stubGlobal("fetch", mockFetch([BACKLINKS[0]]));

    renderSection(NOTE_ID);

    expect(await screen.findByText("Mentioned in 1 note")).toBeInTheDocument();
  });

  it("chips are always visible, no click to expand", async () => {
    vi.stubGlobal("fetch", mockFetch(BACKLINKS));

    renderSection(NOTE_ID);
    await screen.findByText("Mentioned in 2 notes");

    expect(screen.getByRole("link", { name: "Alpha" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Beta" })).toBeVisible();
  });

  it("chips have no collapse semantics: no <details>/<summary> nodes", async () => {
    vi.stubGlobal("fetch", mockFetch(BACKLINKS));

    const { container } = renderSection(NOTE_ID);
    await screen.findByText("Mentioned in 2 notes");

    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("summary")).toBeNull();
  });

  // Height guard: a large count must not grow the content card or this row; class strings are asserted directly (jsdom applies no CSS, same approach as the layout test):
  //   footer root     `shrink-0` (doesn't give up height to the flex-1 scroll container above) + `border-t`
  //   content row     SIDEBAR_ROW_HEIGHT (same height as the sidebar account row, see ui/rows.ts)
  //   chips container `overflow-x-scroll` (the scrollbar always reserves space) + chip `shrink-0 whitespace-nowrap`
  //                   (single row, horizontal scroll; missing either one wraps and grows the row)
  it("single-row horizontal scroll: footer shrink-0/border-t, fixed-height content row, chips don't wrap", async () => {
    vi.stubGlobal("fetch", mockFetch(BACKLINKS));

    const { container } = renderSection(NOTE_ID);
    const title = await screen.findByText("Mentioned in 2 notes");

    const footerRoot = container.firstElementChild;
    expect(footerRoot).not.toBeNull();
    // `py-2` is the other half of the equal height with the account row container's `p-2` (the row height itself comes from SIDEBAR_ROW_HEIGHT, ui/rows.ts);
    // pinned together, so changing it to py-3 goes red.
    // Horizontal padding isn't at this level: the content row has its own `px-5` (full card width, same inset as the page header);
    // the outer stays unpadded so the divider spans the whole card.
    expect(footerRoot).toHaveClass("shrink-0", "border-t", "border-border", "py-2");
    expect(footerRoot?.className).not.toContain("px-");

    const row = title.parentElement;
    expect(row).not.toBeNull();
    expect(row).toHaveClass("flex", "items-center", SIDEBAR_ROW_HEIGHT);
    // The content row is full card width with `px-5`; the reverse guard (must not import the article column constants) is in `components/ui/article-column.guard.test.ts`.
    expect(row).toHaveClass("px-5");

    // The alignment offset must live on the **chips container** (pushing the chips down), not on the label (pulling the group up):
    // the latter takes the whole row out of line with the sidebar account row, and with 0 notes (no scrollbar) the label would still sit high.
    expect(title.className).not.toContain("mb-2.5");

    const chip = screen.getByRole("link", { name: "Alpha" });
    const chipsContainer = chip.parentElement;
    expect(chipsContainer).not.toBeNull();
    // **Same-row structure**: the chips container must be a sibling of the label's row (same flex row). Without this,
    // moving the chips container outside the row as a second line changes no class, so the class assertions below
    // would stay green while the layout (and equal height) is broken.
    expect(chipsContainer?.parentElement).toBe(row);
    // `overflow-x-scroll` (not `-auto`): the scrollbar always reserves space, so the chips' vertical position doesn't
    // jump 5px with the number of backlinks (see the component comment).
    expect(chipsContainer).toHaveClass("flex", "min-w-0", "flex-1", "overflow-x-scroll");
    expect(chipsContainer?.className).not.toContain("overflow-x-auto");
    // The history bubble sits at the bottom edge of the content area, above this row, so the chips' end needs no reserved space.
    expect(chipsContainer).not.toHaveClass("pr-14");

    // The scrollbar geometry all comes from constants in ui/rows.ts (container height = row height + scrollbar, negative margin pulling back,
    // 6px strip scrollbar + 1px thumb border). Missing any one takes the chips out of line with the label or grows the row.
    expect(chipsContainer).toHaveClass(...BACKLINKS_SCROLL_ROW.split(" "), "items-center");
    // `mt-2.5` (which relied on the global 10px scrollbar) must not come back.
    expect(chipsContainer?.className).not.toContain("mt-2.5");

    // The other half of the geometry is in index.css: global scrollbar 10px, overridden to 6px by this strip's `scrollbar-x-thin`
    // (`h-[42px]`: 42 = 36 + 6). Both sides are pinned here: changing only one takes the chips out of line with the label.
    // Comments are stripped before matching (as in theme.scrollbar-guard.test.ts), so a commented-out block can't match in comment text.
    const indexCss = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // The global size goes through the `--scrollbar-size` variable (the picker's scrollbar shares the same value, see theme.scrollbar-guard.test.ts),
    // so match through the variable, not the literal: the rule must reference the variable and the variable must be 10px.
    expect(indexCss).toMatch(/(?<![\w.-])::-webkit-scrollbar\s*\{[^}]*height:\s*var\(--scrollbar-size\)/);
    expect(indexCss, "全域捲軸尺寸變了，本 strip 的 42＝36＋6 要重算").toMatch(/--scrollbar-size:\s*10px/);
    expect(indexCss).toMatch(/\.scrollbar-x-thin::-webkit-scrollbar\s*\{[^}]*height:\s*6px/);
    expect(indexCss).toMatch(/\.scrollbar-x-thin::-webkit-scrollbar-thumb\s*\{[^}]*border-width:\s*1px/);
    expect(chipsContainer?.className).not.toContain("flex-wrap");
    expect(chip).toHaveClass("shrink-0", "whitespace-nowrap");
  });
});
