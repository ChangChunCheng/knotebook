import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BlockNoteEditor, SuggestionMenu } from "@blocknote/core";
import { FilePanelExtension, SideMenuExtension } from "@blocknote/core/extensions";
import type { DefaultReactSuggestionItem } from "@blocknote/react";
import type { AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { SelectionAiController } from "@/components/ai/SelectionAiController";
import { stubLayoutTier } from "@/test/layout-tier";
import { createTestEditor, renderAiHost, selectInBlock, stubAiFetch } from "@/test/ai-host";
import { installLiveStopInput } from "@/components/tour/live-stops";
import { NoteEditorView } from "./NoteEditor";

// The emoji data is a JSON module and importing it in node fails; the `:` menu tests only look at outer positioning, so the default data source is replaced (positioning options are passed through as is).
vi.mock("@blocknote/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@blocknote/react")>();
  const Original = actual.GridSuggestionMenuController as (props: Record<string, unknown>) => ReactNode;
  return {
    ...actual,
    GridSuggestionMenuController: (props: Record<string, unknown>) =>
      Original({ ...props, getItems: async () => [{ id: "x", onItemClick: () => {} }] }),
  };
});

/**
 * This file mounts a real `<BlockNoteView>` (`@blocknote/mantine`, brings its own `MantineProvider`) to pin the two contracts of the `NoteEditorView` JSX wiring:
 *
 * 1. `filePanel={false}` really turns off BlockNote's built-in `FilePanelController` (otherwise opening a file-type block shows two panels stacked).
 * 2. `useMemo(() => createFilePanel(noteId), [noteId])` really pins the `filePanel` component identity: when `noteId` is unchanged and `NoteEditorView` re-renders for any reason,
 *    `FilePanelController` doesn't treat it as a different component and remount it (which would clear an Embed URL half typed).
 *
 * jsdom lacks `ResizeObserver`/`window.matchMedia` (touched by mantine's `MantineProvider` and `@blocknote/react`'s `usePrefersColorScheme`);
 * one-line stubs for both are in `test/setup.ts`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple; any by repo convention (same as NoteEditor.tsx/NoteEditor.test.ts)
function mountedEditor(): { editor: BlockNoteEditor<any, any, any>; container: HTMLElement } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  const editor = BlockNoteEditor.create({ schema: noteSchema }) as BlockNoteEditor<any, any, any>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  return { editor, container };
}

/** Inserts an image block (it has Upload + Embed tabs; the tab bar in `FilePanel.tsx` only renders for this type) and returns its id. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
function insertImageBlock(editor: BlockNoteEditor<any, any, any>): string {
  const first = editor.document[0]!;
  return editor.insertBlocks([{ type: "image" } as never], first, "after")[0]!.id;
}

// SuggestionMenuController needs it, but this file doesn't test the `[[` trigger, so an empty array is enough.
async function getItems(): Promise<DefaultReactSuggestionItem[]> {
  return [];
}

/** The own FilePanel reads `useAuthConfig()` and needs a QueryClientProvider; config returns settings without `maxUploadBytes` (no pre-check). */
function QueryWrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("NoteEditorView (filePanel={false} + useMemo wiring)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    ({ editor, container } = mountedEditor());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    editor.unmount();
    container.remove();
  });

  it("filePanel={false} turns off the built-in panel: opening a FilePanel shows exactly 1 tablist (ours, not the built-in one on top)", () => {
    const blockId = insertImageBlock(editor);
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />, { wrapper: QueryWrapper });

    act(() => {
      editor.getExtension(FilePanelExtension)!.showMenu(blockId);
    });

    expect(screen.getAllByRole("tablist")).toHaveLength(1);
  });

  it("useMemo guard: noteId unchanged and the component re-renders for some reason -> a half-typed Embed value isn't cleared", () => {
    const blockId = insertImageBlock(editor);
    const { rerender } = render(
      <NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
      { wrapper: QueryWrapper },
    );

    act(() => {
      editor.getExtension(FilePanelExtension)!.showMenu(blockId);
    });

    fireEvent.click(screen.getByRole("tab", { name: "Embed link" }));
    const input = screen.getByPlaceholderText("Paste a link…");
    fireEvent.change(input, { target: { value: "https://example.com/half-typed" } });
    expect(input).toHaveValue("https://example.com/half-typed");

    // Same noteId, only the parent re-renders (e.g. an editable/theme prop unrelated to filePanel changes, or just a parent redraw):
    // if the `filePanel` component identity weren't pinned by `useMemo`, `FilePanelController` would mount it as a new component and the Embed input state below would be wiped.
    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);

    expect(screen.getByPlaceholderText("Paste a link…")).toHaveValue("https://example.com/half-typed");
  });
});

// issue #94: `slashMenu={false}` + the own `/` controller wiring. The comment in `NoteEditor.tsx` says that not setting it to false explicitly mounts two `/` menu controllers (pressing `/` shows two menus stacked); this is where that statement is pinned.

describe("NoteEditorView (issue #94: / menu takeover)", () => {
  /** Source of the `[[` menu, to check it also gets the phone floating options. */
  async function getWikilinkItems(): Promise<DefaultReactSuggestionItem[]> {
    return [{ title: "Linked note", onItemClick: () => {} }] as DefaultReactSuggestionItem[];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;

  /** A `/` menu source with a single item, to check that what's mounted is **our** controller. */
  async function getSlashItems(): Promise<DefaultReactSuggestionItem[]> {
    return [{ title: "Diagram", onItemClick: () => {}, group: "Advanced" }] as DefaultReactSuggestionItem[];
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    ({ editor, container } = mountedEditor());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    editor.unmount();
    container.remove();
  });

  it("slashMenu={false}: pressing / shows exactly one menu (not stacked on the built-in one)", () => {
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getSlashItems} />);

    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("/");
    });

    expect(document.querySelectorAll(".bn-suggestion-menu")).toHaveLength(1);
  });

  it("that menu is ours (the getSlashItems item is really rendered)", async () => {
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getSlashItems} />);

    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("/");
    });

    expect(await screen.findByText("Diagram")).toBeInTheDocument();
  });

  /** Max height of the menu's outer layer (the floating-ui positioned one); only has a value after the size middleware applies. */
  async function floatingMaxHeight(itemText = "Diagram"): Promise<string> {
    await screen.findByText(itemText);
    const floating = document.querySelector(".bn-suggestion-menu")!.closest<HTMLElement>("[style*='z-index']")!;
    await waitFor(() => expect(floating.style.maxHeight).not.toBe(""));
    return floating.style.maxHeight;
  }

  it("phone: the menu max height is min(50vh, available height)", async () => {
    stubLayoutTier("phone");
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getSlashItems} />);
    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("/");
    });
    expect(await floatingMaxHeight()).toMatch(/^min\(50vh, /);
  });

  it("phone: the [[ menu likewise gets min(50vh, available height)", async () => {
    stubLayoutTier("phone");
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getWikilinkItems} getSlashItems={getSlashItems} />);
    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("[[");
    });
    expect(await floatingMaxHeight("Linked note")).toMatch(/^min\(50vh, /);
  });

  /** The `:` emoji menu: it appears only after typing two characters (minQueryLength 2), and the cells contain emoji rather than text, so look at the outer element instead. */
  async function emojiFloatingMaxHeight(): Promise<string> {
    editor.focus();
    editor.setTextCursorPosition(editor.document[0]!, "end");
    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu(":");
    });
    act(() => {
      editor.insertInlineContent(["sm"]);
    });
    const grid = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".bn-grid-suggestion-menu");
      expect(el).not.toBeNull();
      return el!;
    });
    const floating = grid.closest<HTMLElement>("[style*='z-index']")!;
    await waitFor(() => expect(floating.style.maxHeight).not.toBe(""));
    return floating.style.maxHeight;
  }

  it("phone: the : emoji menu likewise gets min(50vh, available height)", async () => {
    stubLayoutTier("phone");
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getSlashItems} />);
    expect(await emojiFloatingMaxHeight()).toMatch(/^min\(50vh, /);
  });

  it("width >= 640: the : emoji menu max height stays at the default (no 50vh)", async () => {
    stubLayoutTier("docked");
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getSlashItems} />);
    expect(await emojiFloatingMaxHeight()).not.toContain("50vh");
  });

  it("width >= 640: the [[ menu max height stays at the default (no 50vh)", async () => {
    stubLayoutTier("docked");
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getWikilinkItems} getSlashItems={getSlashItems} />);
    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("[[");
    });
    expect(await floatingMaxHeight("Linked note")).not.toContain("50vh");
  });

  it("width >= 640: the menu max height stays at the default (no 50vh)", async () => {
    stubLayoutTier("docked");
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getSlashItems} />);
    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("/");
    });
    expect(await floatingMaxHeight()).not.toContain("50vh");
  });
});

// The feature tour must point at the real `[[` menu: the outer popover carries the tour target attribute.

describe("NoteEditorView (the `[[` menu carries the tour target attribute)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    ({ editor, container } = mountedEditor());
  });

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  async function getWikilinkItems(): Promise<DefaultReactSuggestionItem[]> {
    return [{ title: "Some note", onItemClick: () => {} }] as DefaultReactSuggestionItem[];
  }

  it("the `[[` menu's popover carries data-kb-tour-target=wikilinkMenu and the `/` menu's carries slashMenu, the default z-index remains; neither carries the other's", async () => {
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getWikilinkItems} getSlashItems={getItems} />);

    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("[[");
    });
    expect(await screen.findByText("Some note")).toBeInTheDocument();
    const popover = document.querySelector<HTMLElement>('[data-kb-tour-target="wikilinkMenu"]')!;
    expect(popover).not.toBeNull();
    expect(document.querySelector('[data-kb-tour-target="slashMenu"]')).toBeNull();
    expect(popover).toContainElement(document.querySelector(".bn-suggestion-menu"));
    expect(popover.style.zIndex).toContain("80");

    act(() => {
      editor.getExtension(SuggestionMenu)!.closeMenu();
    });
    await waitFor(() => expect(document.querySelector(".bn-suggestion-menu")).toBeNull());
    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("/");
    });
    await waitFor(() => expect(document.querySelector(".bn-suggestion-menu")).not.toBeNull());
    const slashPopover = document.querySelector<HTMLElement>('[data-kb-tour-target="slashMenu"]')!;
    expect(slashPopover).not.toBeNull();
    expect(slashPopover).toContainElement(document.querySelector(".bn-suggestion-menu"));
    expect(slashPopover.style.zIndex).toContain("80");
    expect(document.querySelector('[data-kb-tour-target="wikilinkMenu"]')).toBeNull();
  });
});

describe("NoteEditorView (feature-tour keyboard interception sits in front of the real [[ menu)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;
  let uninstall: (() => void) | null = null;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    ({ editor, container } = mountedEditor());
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    editor.unmount();
    container.remove();
  });

  /** Opens the `[[` menu; returns the spy for "item chosen" and a function that sends keys to the editor. */
  async function openMenu(withInput: boolean) {
    const onItemClick = vi.fn();
    const items = async () => [{ title: "Some note", onItemClick }] as DefaultReactSuggestionItem[];
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={items} getSlashItems={getItems} />);
    act(() => {
      editor.getExtension(SuggestionMenu)!.openSuggestionMenu("[[", { deleteTriggerCharacter: false });
    });
    expect(await screen.findByText("Some note")).toBeInTheDocument();
    if (withInput) uninstall = installLiveStopInput({ next: () => {}, back: () => {} });
    const press = (init: KeyboardEventInit) => {
      act(() => {
        editor.domElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
      });
    };
    return { onItemClick, press };
  }

  it("without the interception Ctrl+Enter selects a menu item (confirms this case can measure the difference)", async () => {
    const { onItemClick, press } = await openMenu(false);
    press({ key: "Enter", ctrlKey: true });
    expect(onItemClick).toHaveBeenCalledTimes(1);
  });

  it("interception on: Enter and Ctrl/Alt/Meta+Enter don't select an item, the menu stays open; Ctrl+A doesn't close the menu", async () => {
    const { onItemClick, press } = await openMenu(true);
    for (const init of [{ key: "Enter" }, { key: "Enter", ctrlKey: true }, { key: "Enter", altKey: true }, { key: "Enter", metaKey: true }, { key: "a", ctrlKey: true }]) {
      press(init);
    }
    expect(onItemClick).not.toHaveBeenCalled();
    expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(true);
  });
});

// #263: the formatting toolbar is owned by the SelectionAiController in children. NoteEditorView itself only sets `formattingToolbar={false}` and no longer mounts FormattingToolbarController;
// toolbar suppression and the AI item's behaviour are tested in `components/ai/SelectionAiController.test.tsx`. This only pins the wiring: no children -> no toolbar; with a controller as children -> toolbar.
const AI_ACTION: AiActionDto = { id: "action-1", name: "Summarize", applyMode: "preview", kind: "quick" };
const ONE_PARAGRAPH = [{ id: "p1", type: "paragraph", content: "hello world" }];
const TWO_PARAGRAPHS = [...ONE_PARAGRAPH, { id: "p2", type: "paragraph", content: "second line" }];

describe("NoteEditorView (#263: children pass through; the toolbar is owned by SelectionAiController)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("no children: a non-empty selection shows no formatting toolbar; with SelectionAiController as children it appears (default buttons + AI button)", async () => {
    const editor = createTestEditor(ONE_PARAGRAPH);
    stubAiFetch({ actions: [AI_ACTION] });
    const host = renderAiHost({ editor });
    await waitFor(() => expect(host.queryClient.getQueryState(["ai-actions"])?.status).toBe("success"));
    selectInBlock(editor, "p1", 0, 5);
    await act(async () => {});
    expect(document.querySelector(".bn-formatting-toolbar")).toBeNull();

    host.rerenderHost({ children: <SelectionAiController /> });
    expect(await screen.findByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "AI" })).toBeInTheDocument();
  });

  it("viewer (editable:false) -> the AI item isn't rendered", async () => {
    const editor = createTestEditor(ONE_PARAGRAPH);
    stubAiFetch({ actions: [AI_ACTION] });
    const host = renderAiHost({ editor, editable: false, children: <SelectionAiController /> });
    await waitFor(() => expect(host.queryClient.getQueryState(["ai-actions"])?.status).toBe("success"));
    selectInBlock(editor, "p1", 0, 5);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "AI" })).not.toBeInTheDocument();
  });

  it("actions is an empty array (editable:true) -> default buttons as usual, the AI item isn't rendered", async () => {
    const editor = createTestEditor(ONE_PARAGRAPH);
    stubAiFetch({ actions: [] });
    const host = renderAiHost({ editor, children: <SelectionAiController /> });
    await waitFor(() => expect(host.queryClient.getQueryState(["ai-actions"])?.status).toBe("success"));
    selectInBlock(editor, "p1", 0, 5);
    expect(await screen.findByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "AI" })).not.toBeInTheDocument();
  });
});

describe("NoteEditorView (block handle: no side menu on phone)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, "elementsFromPoint");
  });

  async function hoverFirstParagraph() {
    const editor = createTestEditor(ONE_PARAGRAPH);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor });
    const paragraph = await screen.findByText("hello world");
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [paragraph] });
    act(() => {
      fireEvent.mouseMove(paragraph, { clientX: 0, clientY: 0 });
    });
    await act(async () => {});
  }

  it("docked: hovering over a block shows the drag handle", async () => {
    stubLayoutTier("docked");
    await hoverFirstParagraph();
    expect(await screen.findByLabelText("Open block menu")).toBeInTheDocument();
  });

  it("phone: hovering over a block shows no drag handle either", async () => {
    stubLayoutTier("phone");
    await hoverFirstParagraph();
    expect(screen.queryByLabelText("Open block menu")).not.toBeInTheDocument();
    expect(document.querySelector("[data-kb-side-menu-popover]")).toBeNull();
  });
});

describe("NoteEditorView (tier narrows to phone width while a block menu is open)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, "elementsFromPoint");
  });

  it("side menu frozen then switched to phone: unfreezes, no exception; after switching back to docked, hovering another block moves the handle there", async () => {
    const tier = stubLayoutTier("docked");
    const editor = createTestEditor(TWO_PARAGRAPHS);
    stubAiFetch({ actions: [] });
    renderAiHost({ editor });
    const first = await screen.findByText("hello world");
    const second = await screen.findByText("second line");
    let hovered: HTMLElement = first;
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [hovered] });
    act(() => {
      fireEvent.mouseMove(first, { clientX: 0, clientY: 0 });
    });
    fireEvent.click(await screen.findByLabelText("Open block menu"));
    const sideMenu = editor.getExtension(SideMenuExtension)!;
    await waitFor(() => expect(sideMenu.store.state?.show).toBe(true));
    act(() => tier.setLayoutTier("phone"));
    await waitFor(() => expect(sideMenu.store.state?.show).toBe(false));
    expect(screen.queryByLabelText("Open block menu")).not.toBeInTheDocument();
    act(() => tier.setLayoutTier("docked"));
    hovered = second;
    act(() => {
      fireEvent.mouseMove(second, { clientX: 0, clientY: 20 });
    });
    await waitFor(() => expect(sideMenu.store.state?.block.id).toBe("p2"));
    expect(sideMenu.store.state?.show).toBe(true);
  });
});
