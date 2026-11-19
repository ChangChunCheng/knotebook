import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { AiPreview } from "@/ai/preview";
import "@/i18n";
import type { DiffBlock } from "@/lib/version-diff";
import { ThemeProvider } from "@/theme";
import { SelectionAiPreview } from "./SelectionAiPreview";

const para = (id: string, text: string): DiffBlock => ({ id, type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] });

function makePreview(afterText: string): AiPreview {
  return { before: [para("a1", "original middle sentence")], after: [para("n1", afterText)], noChange: false };
}

describe("SelectionAiPreview (#263)", () => {
  it("renders only the changed blocks, each marked per diff (added/deleted/changed)", async () => {
    render(
      <ThemeProvider>
        <SelectionAiPreview preview={makePreview("totally new text")} onReady={() => {}} />
      </ThemeProvider>,
    );
    await screen.findByTestId("selection-ai-preview");
    const marks = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="selection-ai-preview"] .bn-block-outer[data-id]')).map((el) =>
      el.getAttribute("data-diff"),
    );
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((mark) => mark === "added" || mark === "deleted" || mark === "changed")).toBe(true);
  });

  it("ready signal: onReady(that preview) after mount; a new preview calls onReady(null) then onReady(the new one); unmount calls onReady(null)", async () => {
    const onReady = vi.fn();
    const first = makePreview("first result");
    const second = makePreview("second result");
    const { rerender, unmount } = render(
      <ThemeProvider>
        <SelectionAiPreview preview={first} onReady={onReady} />
      </ThemeProvider>,
    );
    await screen.findByTestId("selection-ai-preview");
    expect(onReady.mock.calls).toEqual([[first]]);
    rerender(
      <ThemeProvider>
        <SelectionAiPreview preview={second} onReady={onReady} />
      </ThemeProvider>,
    );
    expect(onReady.mock.calls).toEqual([[first], [null], [second]]);
    unmount();
    expect(onReady.mock.calls.at(-1)).toEqual([null]);
  });

  it("#269: a wikilink block changed only in its snapshot (snapshotTitle differs from label after the AI round trip) is not marked; also renders when the cache has no note list (titleOf empty)", async () => {
    const wl = (snap: string) => ({ type: "wikilink", props: { targetNoteId: "11111111-1111-4111-8111-111111111111", snapshotTitle: snap, label: "L", anchorBlockId: "" } });
    const preview: AiPreview = { before: [{ id: "a", type: "paragraph", content: [wl("Target")], children: [] }], after: [{ id: "a", type: "paragraph", content: [wl("L")], children: [] }], noChange: false };
    // Wikilinks in unchanged blocks are rendered by MemberWikilink (needs QueryClient and Router); queries are disabled by default, so no /api/notes request is made and the cache stays empty.
    const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <SelectionAiPreview preview={preview} onReady={() => {}} />
          </ThemeProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const box = await screen.findByTestId("selection-ai-preview");
    expect(box.querySelector("[data-diff]")?.getAttribute("data-diff") ?? "context").toBe("context");
  });

  it("#269: a wikilink without label inside a changed block shows the cached current title - titleOf reaches renderDiff and the two snapshots are not shown", async () => {
    const ID = "11111111-1111-4111-8111-111111111111";
    const wl = (snap: string) => ({ type: "wikilink", props: { targetNoteId: ID, snapshotTitle: snap, label: "", anchorBlockId: "" } });
    const text = (t: string) => ({ type: "text", text: t, styles: {} });
    const preview: AiPreview = {
      before: [{ id: "a", type: "paragraph", content: [wl("Target"), text(" x")], children: [] }],
      after: [{ id: "a", type: "paragraph", content: [wl("Other"), text(" y")], children: [] }],
      noChange: false,
    };
    // Queries are disabled, so no /api/notes request; the list only comes from data placed in the cache beforehand (the hook subscribes passively).
    const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    queryClient.setQueryData(["notes"], [{ id: ID, title: "Live", ownerHandle: "ann", groupId: null, slug: "live" }]);
    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <SelectionAiPreview preview={preview} onReady={() => {}} />
          </ThemeProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const box = await screen.findByTestId("selection-ai-preview");
    const block = box.querySelector('[data-id="a"]');
    expect(block?.getAttribute("data-diff")).toBe("changed");
    expect(block).toHaveTextContent("Live");
    expect(block).not.toHaveTextContent("Target");
    expect(block).not.toHaveTextContent("Other");
  });

  it("columns expanded to a whole row: before and after are both one row (right column b -> B): renders without throwing, B is visible, onReady is called", async () => {
    const twoCols = (id: string, left: DiffBlock, right: DiffBlock): DiffBlock => ({
      id,
      type: "columnList",
      props: {},
      children: [
        { id: `${id}c0`, type: "column", props: { width: 1 }, children: [left] },
        { id: `${id}c1`, type: "column", props: { width: 1 }, children: [right] },
      ],
    });
    const preview: AiPreview = {
      before: [twoCols("r", para("a1", "a"), para("b1", "b"))],
      after: [twoCols("n", para("n1", "a"), para("n2", "B"))],
      noChange: false,
    };
    const onReady = vi.fn();
    render(
      <ThemeProvider>
        <SelectionAiPreview preview={preview} onReady={onReady} />
      </ThemeProvider>,
    );
    const box = await screen.findByTestId("selection-ai-preview");
    expect(box).toHaveTextContent("B");
    expect(onReady).toHaveBeenCalledWith(preview);
  });
});

describe("index.css: styles for the selection AI preview (#263)", () => {
  const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8");
  it("no faint rule for context blocks (the preview carries no surrounding context)", () => {
    expect(css).not.toContain('data-diff="surround"');
  });
  it("the read-only editor in the box has zero left/right padding, with the selector raised to (0,3,0)", () => {
    expect(css).toMatch(/\.kb-ai-preview \.bn-editor\.bn-editor \{[^}]*padding-inline: 0;/);
  });
  it("the four color bars use inset box-shadow with border-left removed, selector (0,4,0)", () => {
    for (const mark of ["added", "deleted", "changed", "moved"]) {
      expect(css).toMatch(new RegExp(`\\.kb-ai-preview \\.kb-diff \\[data-diff="${mark}"\\] > \\.bn-block \\{[^}]*border-left: 0;[^}]*box-shadow: inset 3px 0 0 `));
    }
  });
});
