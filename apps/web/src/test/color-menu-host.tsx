import type { ReactNode } from "react";
import { expect } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BlockNoteView } from "@blocknote/mantine";
import { useComponentsContext } from "@blocknote/react";
import type { BlockNoteEditor } from "@blocknote/core";
import { installCustomColors } from "@/lib/custom-colors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple; any per repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;

function HostMenu({ children }: { children?: ReactNode }) {
  const Components = useComponentsContext()!;
  return (
    <Components.Generic.Menu.Root>
      <Components.Generic.Menu.Trigger>
        <button type="button" data-testid="host-trigger">
          open
        </button>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown className="bn-menu-dropdown">{children}</Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}

/**
 * Shared host for the colour menu tests: a root menu inside BlockNoteView, with the dropdown content decided by children.
 * When `installColors` is true the custom colour observer is installed before mounting (same order as production).
 */
export function renderColorMenuHost(editor: AnyEditor, children?: ReactNode, opts: { installColors?: boolean } = {}) {
  if (opts.installColors) installCustomColors(document.body);
  return render(
    <BlockNoteView editor={editor} theme="light" formattingToolbar={false} slashMenu={false} sideMenu={false}>
      <HostMenu>{children}</HostMenu>
    </BlockNoteView>,
  );
}

// jsdom has no layout, so floating-ui's hide middleware marks the dropdown display:none; always query with hidden: true to see whether a node is still mounted.
export const menuNode = () => screen.queryByRole("menu", { hidden: true });

/** Lets the transition and Mantine's initial-focus timer run out. */
export const settle = (ms = 400) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/**
 * Gives the trigger and the window a non-zero layout so floating-ui's hide middleware judges the trigger visible and the dropdown stops being marked display:none.
 * Mantine focus trap's Tab wrap-around (`scopeTab`) only recognises elements with no display:none ancestor, so to test Tab wrap-around call this first;
 * it must be called before opening the menu. `trigger` is the element the menu is anchored to (e.g. the toolbar colour button, the drag handle); defaults to the host's trigger when omitted.
 * Returns a restore function.
 */
export function layoutHostTrigger(trigger: HTMLElement = screen.getByTestId("host-trigger")): () => void {
  const html = document.documentElement;
  Object.defineProperty(html, "clientWidth", { value: 1024, configurable: true });
  Object.defineProperty(html, "clientHeight", { value: 768, configurable: true });
  const triggerEl = trigger;
  triggerEl.getBoundingClientRect = () => new DOMRect(100, 100, 40, 20);
  return () => {
    delete (html as { clientWidth?: number }).clientWidth;
    delete (html as { clientHeight?: number }).clientHeight;
    delete (triggerEl as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  };
}

/**
 * Waits until the dropdown is no longer marked display:none by floating-ui (use with `layoutHostTrigger`). `menu` returns the dropdown to wait for,
 * pass it when more than one menu is on screen; when omitted it takes the sole `role="menu"`.
 */
export async function waitForMenuShown(menu: () => HTMLElement = () => screen.getByRole("menu", { hidden: true })) {
  await waitFor(() => expect(menu().style.display).not.toBe("none"));
}

export async function openHostMenu() {
  fireEvent.click(screen.getByTestId("host-trigger"));
  await screen.findByRole("menu", { hidden: true });
  await act(() => new Promise<void>((r) => setTimeout(r, 0)));
}

// Tailwind 4's default `--spacing: 0.25rem`, so `p-1` is 4px
const SPACING_PX = 4;

/**
 * jsdom has no layout: computes the content width from the `w-[Npx]` declared on the class and the horizontal padding (`p-N` / `px-N` / `pl-N` / `pr-N`)
 * (Tailwind preflight is border-box, so the width includes padding). Throws on any other class that affects width, so a wrong computation can't stay green.
 */
export function declaredContentWidth(el: Element): number {
  let width: number | null = null;
  let left = 0;
  let right = 0;
  for (const c of Array.from(el.classList)) {
    const w = /^w-\[(\d+(?:\.\d+)?)px\]$/.exec(c);
    const p = /^p([xlr]?)-(\d+(?:\.\d+)?)$/.exec(c);
    if (w) width = Number(w[1]);
    else if (p) {
      const v = Number(p[2]) * SPACING_PX;
      if (p[1] !== "r") left = v;
      if (p[1] !== "l") right = v;
    } else if (/^(w|min-w|max-w|p|px|pl|pr|ps|pe|border|border-x|border-l|border-r)(-|$)/.test(c)) {
      throw new Error(`declaredContentWidth 不認得 class ${c}`);
    }
  }
  if (width === null) throw new Error("元素沒有宣告 w-[Npx]");
  return width - left - right;
}
