import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { REWRITE_ACTION_ID, SUMMARIZE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { contentStart, createTestEditor, renderAiHost, selectInBlock, stubAiFetch, type AnyEditor } from "@/test/ai-host";
import { createRequire } from "node:module";
import { useAiSession, type AiSessionValue } from "./AiSession";
import { SelectionAiController, PHONE_EDIT_TOOLBAR_CLEARANCE_PX, formattingToolbarMiddleware } from "./SelectionAiController";
import { stubLayoutTier } from "@/test/layout-tier";
import { STICKY_TOP_VAR } from "@/lib/page-scroll";

// flip is replaced by a pass-through that records its arguments: verifies the bottom inset passed on phones.
const flipSpy = vi.hoisted(() => vi.fn());
vi.mock("@floating-ui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@floating-ui/react")>();
  return {
    ...actual,
    flip: (options?: Parameters<typeof actual.flip>[0]) => {
      flipSpy(options);
      return actual.flip(options);
    },
  };
});

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };
const SUMMARIZE: AiActionDto = { id: SUMMARIZE_ACTION_ID, name: "Summarize", applyMode: "preview", kind: "quick" };

const DOC = [
  { id: "p1", type: "paragraph", content: "alpha beta gamma" },
  { id: "p2", type: "paragraph", content: "second paragraph" },
  { id: "p3", type: "paragraph", content: "third paragraph here" },
  { id: "img", type: "image", props: { url: "https://example.com/a.png" } },
];

// prosemirror-tables is not a direct dependency of the app: resolved from @blocknote/core's location to get the CellSelection it actually uses.
const coreRequire = createRequire(createRequire(import.meta.url).resolve("@blocknote/core"));
const { CellSelection } = coreRequire("prosemirror-tables") as { CellSelection: { create(doc: unknown, anchor: number, head: number): never } };

let session!: AiSessionValue;
function Probe() {
  session = useAiSession();
  return null;
}

let editor: AnyEditor;
const toolbar = () => document.querySelector(".bn-formatting-toolbar");

async function mount(doc: unknown[] = DOC) {
  editor = createTestEditor(doc);
  const ai = stubAiFetch({ actions: [REWRITE, SUMMARIZE] });
  renderAiHost({
    editor,
    children: (
      <>
        <SelectionAiController />
        <Probe />
      </>
    ),
  });
  await waitFor(() => expect(session.actions).toHaveLength(2));
  return ai;
}

describe("SelectionAiController (#263: toolbar suppression and AI button)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("the AI button opens the box; while the box is open and the selection is inside the target the built-in toolbar hides; it comes back after the box closes", async () => {
    await mount();
    selectInBlock(editor, "p1", 0, 5);
    fireEvent.click(await screen.findByRole("button", { name: "AI" }));
    expect(session.state.phase).toBe("input");
    await waitFor(() => expect(toolbar()).toBeNull());
    act(() => session.close());
    await waitFor(() => expect(toolbar()).not.toBeNull());
  });

  it("non-empty selection outside the target while streaming: toolbar appears, box stays open, AI button disabled", async () => {
    const ai = await mount();
    selectInBlock(editor, "p1", 0, 5);
    fireEvent.click(await screen.findByRole("button", { name: "AI" }));
    act(() => {
      session.start(SUMMARIZE.id);
    });
    selectInBlock(editor, "p3", 0, 5);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(session.state.phase).toBe("streaming");
    expect(screen.getByRole("button", { name: "AI" })).toBeDisabled();
    expect(ai.calls).toHaveLength(1);
  });

  it("opening the box after Ctrl+A hides the toolbar (select-all counts as inside the target)", async () => {
    await mount();
    act(() => {
      editor._tiptapEditor.commands.selectAll();
    });
    fireEvent.click(await screen.findByRole("button", { name: "AI" }));
    expect(session.state.phase).toBe("input");
    await waitFor(() => expect(toolbar()).toBeNull());
  });

  it("NodeSelection (an image selected): the toolbar appears as upstream but has no AI item", async () => {
    await mount();
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(screen.queryByRole("button", { name: "AI" })).not.toBeInTheDocument();
  });

  it("the AI item is a single icon button: no dropdown, no aria-expanded", async () => {
    await mount();
    selectInBlock(editor, "p1", 0, 5);
    const button = await screen.findByRole("button", { name: "AI" });
    const toolbarRoot = button.closest<HTMLElement>(".bn-formatting-toolbar")!;
    expect(button).not.toHaveAttribute("aria-expanded");
    expect(button.querySelector('svg[data-icon="sparkles"]')).not.toBeNull();
    fireEvent.click(button);
    // The old dropdown list was drawn inside the toolbar root; now pressing only opens the box (the action chips live in the box).
    expect(within(toolbarRoot).queryByRole("button", { name: REWRITE.name })).not.toBeInTheDocument();
  });
});

describe("SelectionAiController (phone: controller always mounted, toolbar suppressed while text is selected)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("phone: even a non-empty selection has no formatting toolbar, the AI session can still open", async () => {
    stubLayoutTier("phone");
    await mount();
    selectInBlock(editor, "p1", 0, 5);
    await act(async () => {});
    expect(toolbar()).toBeNull();
    expect(screen.queryByRole("button", { name: "Bold" })).not.toBeInTheDocument();
    act(() => session.open());
    await waitFor(() => expect(session.state.phase).toBe("input"));
    expect(await screen.findByTestId("selection-ai-box")).toBeInTheDocument();
  });

  it("phone: selecting an image block shows the toolbar as before (with the delete button); selecting text hides it; selecting the image again shows it again, as a single instance", async () => {
    stubLayoutTier("phone");
    await mount();
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(toolbar()!.querySelector('[aria-label*="elete"]')).not.toBeNull();
    selectInBlock(editor, "p1", 0, 5);
    await waitFor(() => expect(toolbar()).toBeNull());
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(document.querySelectorAll(".bn-formatting-toolbar")).toHaveLength(1);
  });

  it("phone: a cross-cell selection (CellSelection) shows the toolbar; selecting text inside a cell does not", async () => {
    stubLayoutTier("phone");
    await mount([
      { id: "t1", type: "table", content: { type: "tableContent", rows: [{ cells: ["cell a", "cell b"] }, { cells: ["cell c", "cell d"] }] } },
      { id: "p9", type: "paragraph", content: "after" },
    ]);
    const cellPositions: number[] = [];
    editor.transact((tr) => {
      tr.doc.descendants((node, pos) => {
        if (node.type.name === "tableCell" || node.type.name === "tableHeader") cellPositions.push(pos);
      });
    });
    expect(cellPositions.length).toBeGreaterThanOrEqual(2);
    act(() => {
      editor.transact((tr) => {
        tr.setSelection(CellSelection.create(tr.doc, cellPositions[0]!, cellPositions[1]!));
      });
    });
    await waitFor(() => expect(toolbar()).not.toBeNull());
    act(() => {
      editor._tiptapEditor.commands.setTextSelection({ from: cellPositions[0]! + 3, to: cellPositions[0]! + 6 });
    });
    await waitFor(() => expect(toolbar()).toBeNull());
  });

  it("docked -> phone -> docked: the toolbar disappears then comes back, ending as a single instance", async () => {
    const tier = stubLayoutTier("docked");
    await mount();
    selectInBlock(editor, "p1", 0, 5);
    expect(await screen.findByRole("button", { name: "Bold" })).toBeInTheDocument();
    act(() => tier.setLayoutTier("phone"));
    await waitFor(() => expect(toolbar()).toBeNull());
    act(() => tier.setLayoutTier("docked"));
    await waitFor(() => expect(document.querySelectorAll(".bn-formatting-toolbar")).toHaveLength(1));
    expect(screen.getAllByRole("button", { name: "Bold" })).toHaveLength(1);
  });

  it("docked: the same selection shows the formatting toolbar", async () => {
    stubLayoutTier("docked");
    await mount();
    selectInBlock(editor, "p1", 0, 5);
    expect(await screen.findByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(toolbar()).not.toBeNull();
  });
});

describe("SelectionAiController (phone: the floating toolbar avoids the edit toolbar when flipped below)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    flipSpy.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true, writable: true });
  });

  function stubKeyboard(inset: number) {
    const viewport = Object.assign(new EventTarget(), { height: 800 - inset, offsetTop: 0, scale: 1 });
    vi.stubGlobal("innerHeight", 800);
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true, writable: true });
  }
  // flip options can be a function (evaluated at positioning time; on phones it reads the pinned header height): evaluate first, then read.
  const bottoms = () =>
    flipSpy.mock.calls.map(([options]) => {
      const resolved = typeof options === "function" ? (options as (state: unknown) => unknown)({}) : options;
      return (resolved as { padding?: { bottom?: number } } | undefined)?.padding?.bottom;
    });

  it("phone: flip's bottom inset is the edit toolbar's outer height, without adding the keyboard height (the viewport boundary is already the visual viewport)", async () => {
    stubLayoutTier("phone");
    stubKeyboard(300);
    await mount();
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(bottoms()).toContain(PHONE_EDIT_TOOLBAR_CLEARANCE_PX);
    expect(bottoms().filter((bottom) => bottom !== undefined && bottom !== PHONE_EDIT_TOOLBAR_CLEARANCE_PX)).toEqual([]);
  });

  it("docked: flip keeps the default (no inset)", async () => {
    stubLayoutTier("docked");
    stubKeyboard(300);
    await mount();
    selectInBlock(editor, "p1", 0, 5);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(bottoms().filter((bottom) => bottom !== undefined)).toEqual([]);
  });
});

describe("formattingToolbarMiddleware", () => {
  const names = (bottomPadding: number) => formattingToolbarMiddleware(bottomPadding).map((middleware) => middleware.name);

  it("phone: width is limited first (size), then shift keeps 8px on each side with the whole viewport as boundary, then flip", () => {
    expect(names(PHONE_EDIT_TOOLBAR_CLEARANCE_PX)).toEqual(["offset", "size", "shift", "flip"]);
  });

  it("phone: flip's top inset is the pinned header height (read at positioning time from --kb-sticky-top) and the bottom inset is the edit toolbar", () => {
    const flipOf = () => formattingToolbarMiddleware(PHONE_EDIT_TOOLBAR_CLEARANCE_PX).find((middleware) => middleware.name === "flip")!;
    const padding = () => {
      // The middleware wrapped by @floating-ui/react keeps the original options in options[0].
      const options = (flipOf().options as unknown[])[0];
      const resolved = (typeof options === "function" ? (options as (state: unknown) => unknown)({}) : options) as { padding: { top: number; bottom: number } };
      return resolved.padding;
    };
    expect(padding()).toEqual({ top: 0, bottom: PHONE_EDIT_TOOLBAR_CLEARANCE_PX });
    document.documentElement.style.setProperty(STICKY_TOP_VAR, "96px");
    try {
      expect(padding()).toEqual({ top: 96, bottom: PHONE_EDIT_TOOLBAR_CLEARANCE_PX });
    } finally {
      document.documentElement.style.removeProperty(STICKY_TOP_VAR);
    }
  });

  it("desktop: same as BlockNote's default, no width limit", () => {
    expect(names(0)).toEqual(["offset", "shift", "flip"]);
  });
});
