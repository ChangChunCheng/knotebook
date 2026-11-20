import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BlockNoteEditor } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { SideMenuController } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { P, row, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { FORMATTING_TOOLBAR_ELEMENT_PROPS } from "@/components/ai/SelectionAiController";
import { KnotebookSideMenu, NotePathContext, SIDE_MENU_FLOATING_OPTIONS } from "./KnotebookSideMenu";
import { DRAG_ACTIVE_CLASS, useDragActiveClass } from "./use-drag-active-class";

/**
 * During a drag-and-drop, the handle and the layers outside it must not take the pointer (so the drop can reach the editor underneath). jsdom does not load `index.css`:
 * the `.kb-dragging` rule is extracted verbatim and injected as `<style>`.
 *
 * jsdom's `getComputedStyle` inherits `pointer-events`: closing only the outer layer would make the inner elements also measure as none. So a baseline where every
 * layer explicitly sets auto (lower specificity than the drag rule) is injected first: each layer must be selected by the drag rule directly to measure none, not by
 * inheritance. That way, if some style later sets an explicit `auto` on any layer, the rule will not appear to work just because the outer layer was closed.
 */
const EXPLICIT_AUTO =
  "[data-kb-side-menu-popover], [data-kb-column-side-menu], .bn-side-menu, .bn-side-menu *, [data-floating-ui-portal] * { pointer-events: auto; }";
const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\r\n/g, "\n");
function dragRules(): string {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const selectors = m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (selectors.includes(`.${DRAG_ACTIVE_CLASS}`)) out.push(`${selectors} {${m[2]}}`);
  }
  return out.join("\n");
}

let style: HTMLStyleElement | null = null;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  style = document.createElement("style");
  style.textContent = `${EXPLICIT_AUTO}\n${dragRules()}`;
  document.head.appendChild(style);
});
afterEach(() => {
  style?.remove();
  Reflect.deleteProperty(document, "elementsFromPoint");
});

const fire = (type: string, init: { relatedTarget?: EventTarget | null } = {}) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  if ("relatedTarget" in init) Object.defineProperty(event, "relatedTarget", { value: init.relatedTarget });
  act(() => void document.dispatchEvent(event));
};

/** The column (`columnEl`) mounts `useDragActiveClass`, inside it the real `SideMenuController` + `KnotebookSideMenu` (with the popover marker), same as on the note page. */
function mount(content: PartialBlockLike[]): { editor: AnyEditor; column: () => HTMLElement; unmount(): void } {
  const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: content as never }) as AnyEditor;
  function Column() {
    const [col, setCol] = useState<HTMLElement | null>(null);
    useDragActiveClass(col);
    return (
      <div ref={setCol} data-testid="column">
        <NotePathContext.Provider value="/n/h/note">
          <BlockNoteView editor={editor} editable sideMenu={false}>
            <SideMenuController sideMenu={KnotebookSideMenu} floatingUIOptions={SIDE_MENU_FLOATING_OPTIONS} />
          </BlockNoteView>
        </NotePathContext.Provider>
      </div>
    );
  }
  const { unmount } = render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Column />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { editor, column: () => screen.getByTestId("column"), unmount };
}

/** Points SideMenuView at b in the 2nd column; returns the four hit-test layers of the handle in the column. */
async function hoverColumnBlock(editor: AnyEditor): Promise<Record<"button" | "sideMenu" | "wrapper" | "popover", HTMLElement>> {
  const el = screen.getByText("b");
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [el] });
  act(() => {
    fireEvent.mouseMove(el, { clientX: 0, clientY: 0 });
  });
  expect(editor.getExtension(SideMenuExtension)!.store.state?.block?.id).toBe("b1");
  const button = await screen.findByLabelText("Open block menu");
  const layers = {
    button,
    sideMenu: button.closest<HTMLElement>(".bn-side-menu")!,
    wrapper: button.closest<HTMLElement>("[data-kb-column-side-menu]")!,
    popover: button.closest<HTMLElement>("[data-kb-side-menu-popover]")!,
  };
  for (const [name, layer] of Object.entries(layers)) expect(layer, name).toBeInstanceOf(HTMLElement);
  return layers;
}

const pointerEventsOf = (layers: Record<string, HTMLElement>) =>
  Object.fromEntries(Object.entries(layers).map(([name, el]) => [name, getComputedStyle(el).pointerEvents]));

const CONTENT = () => [P("x", "x1"), row([[P("a", "a1")], [P("b", "b1")]], "r")];
const ALL_NONE = { button: "none", sideMenu: "none", wrapper: "none", popover: "none" };

describe("during a drag-and-drop every layer of the handle inside a column ignores the pointer", () => {
  it("precondition: the handle's popover is inside the column (columnEl), so the ancestor selector holds", async () => {
    const { editor, column } = mount(CONTENT());
    const { popover } = await hoverColumnBlock(editor);
    expect(column().contains(popover)).toBe(true);
  });

  it("document receives dragenter (without a dragstart first: dragged in from the OS or another window): the column gets the class and all four layers compute pointer-events none", async () => {
    const { editor, column } = mount(CONTENT());
    const layers = await hoverColumnBlock(editor);
    for (const value of Object.values(pointerEventsOf(layers))) expect(value).not.toBe("none"); // contrast: without a drag the pointer is taken as usual
    fire("dragenter");
    expect(column().classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
    expect(pointerEventsOf(layers)).toEqual(ALL_NONE);
  });

  it("dragover alone (dragenter missed) also adds the class", async () => {
    const { column } = mount(CONTENT());
    fire("dragover");
    expect(column().classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
  });
});

describe("listeners are in the capture phase", () => {
  it.each(["dragenter", "dragover"])("a %s handler on the drop-target element calling stopPropagation still adds the class", (type) => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    el.addEventListener(type, (e) => e.stopPropagation());
    const column = document.createElement("div");
    const { unmount } = renderHook(() => useDragActiveClass(column));
    try {
      act(() => void el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })));
      expect(column.classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
    } finally {
      unmount();
      el.remove();
    }
  });

  it("a drop handler on the drop-target element calling stopPropagation still clears the class", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    el.addEventListener("drop", (e) => e.stopPropagation());
    const column = document.createElement("div");
    const { unmount } = renderHook(() => useDragActiveClass(column));
    try {
      fire("dragenter");
      act(() => void el.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true })));
      expect(column.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
    } finally {
      unmount();
      el.remove();
    }
  });
});

describe("cleared when the drag ends", () => {
  it.each(["drop", "dragend", "pointermove"])("after dragenter, %s: the class is gone and all four layers take the pointer as usual", async (end) => {
    const { editor, column } = mount(CONTENT());
    const layers = await hoverColumnBlock(editor);
    fire("dragenter");
    expect(pointerEventsOf(layers)).toEqual(ALL_NONE);
    fire(end);
    expect(column().classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
    for (const value of Object.values(pointerEventsOf(layers))) expect(value).not.toBe("none");
  });

  it.each([
    ["relatedTarget is null", null],
    ["relatedTarget is an element", "element"],
  ] as const)("a dragleave mid-drag (%s) does not clear", (_label, related) => {
    const { column } = mount(CONTENT());
    fire("dragenter");
    fire("dragleave", { relatedTarget: related === null ? null : document.body });
    expect(column().classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
  });
});

describe("an erroneous clear restores itself", () => {
  it("dragenter -> pointermove (erroneous clear) -> dragover -> the class is back", () => {
    const { column } = mount(CONTENT());
    fire("dragenter");
    fire("pointermove");
    expect(column().classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
    fire("dragover");
    expect(column().classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
  });
});

describe("unmount and replacing columnEl", () => {
  it("unmount during a drag removes the class; a later dragenter no longer adds it", () => {
    const el = document.createElement("div");
    const { unmount } = renderHook(() => useDragActiveClass(el));
    fire("dragenter");
    expect(el.classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
    unmount();
    expect(el.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
    fire("dragenter");
    expect(el.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
  });

  it("columnEl replaced by another element: the old one is cleared and no longer gets it; the new one takes over", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    const { rerender, unmount } = renderHook(({ el }) => useDragActiveClass(el), { initialProps: { el: first as HTMLElement | null } });
    fire("dragenter");
    rerender({ el: second });
    expect(first.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
    fire("dragover");
    expect(first.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
    expect(second.classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
    rerender({ el: null });
    expect(second.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
    unmount();
  });
});

describe("during a drag-and-drop every layer of the formatting toolbar overlay ignores the pointer; inputs in the same portal still take the pointer", () => {
  // Structure as measured in a browser: floating-ui portal (0x0) > floating-ui wrapper div (carrying the toolbar marker) > `.bn-formatting-toolbar` > buttons.
  // When the handle drag starts core selects the dragged block and the toolbar appears right above it; the wrapper div itself also receives the drop, so every layer must measure none.
  function portalIn(column: HTMLElement): HTMLElement {
    const portal = document.createElement("div");
    portal.setAttribute("data-floating-ui-portal", "");
    column.appendChild(portal);
    return portal;
  }
  function floating(portal: HTMLElement, attrs: Record<string, unknown> = {}): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-floating-ui-focusable", "");
    for (const [name, value] of Object.entries(attrs)) wrapper.setAttribute(name, String(value));
    portal.appendChild(wrapper);
    return wrapper;
  }
  function toolbarIn(portal: HTMLElement): Record<"wrapper" | "toolbar" | "button", HTMLElement> {
    const wrapper = floating(portal, FORMATTING_TOOLBAR_ELEMENT_PROPS as Record<string, unknown>);
    const toolbar = document.createElement("div");
    toolbar.className = "bn-toolbar bn-formatting-toolbar";
    const button = document.createElement("button");
    toolbar.appendChild(button);
    wrapper.appendChild(toolbar);
    return { wrapper, toolbar, button };
  }

  it("dragenter: the column gets the class, and the toolbar's wrapper layer, toolbar and buttons all compute pointer-events none; restored after drop", () => {
    const { column } = mount(CONTENT());
    const layers = toolbarIn(portalIn(column()));
    for (const value of Object.values(pointerEventsOf(layers))) expect(value).not.toBe("none"); // contrast: without a drag the pointer is taken as usual
    fire("dragenter");
    expect(pointerEventsOf(layers)).toEqual({ wrapper: "none", toolbar: "none", button: "none" });
    fire("drop");
    for (const value of Object.values(pointerEventsOf(layers))) expect(value).not.toBe("none");
  });

  it("during a drag the file panel's input[type=file] in the same portal still takes the pointer (it is itself a drop target)", () => {
    const { column } = mount(CONTENT());
    const portal = portalIn(column());
    toolbarIn(portal);
    const panel = document.createElement("div");
    panel.className = "bn-panel";
    const input = document.createElement("input");
    input.type = "file";
    panel.appendChild(input);
    floating(portal).appendChild(panel);
    fire("dragenter");
    expect(column().classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
    expect(pointerEventsOf({ panel, input })).toEqual({ panel: "auto", input: "auto" });
  });
});
