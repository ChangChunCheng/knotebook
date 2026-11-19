import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { TourContext } from "@/lib/tour-context";
import type { ShortcutsStartPage } from "@/lib/shortcuts-dialog";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { stubLayoutTier } from "@/test/layout-tier";

/**
 * Behaviour of the shell (ShortcutsDialog) plus the real content component (ShortcutsLazy) together: the opening landing point, Tab cycling, and choosing a category not closing the dialog.
 * The shell alone (lazy boundary, name, focus return) is in ShortcutsDialog.test.tsx (content replaced by a stand-in); the content alone is in ShortcutsLazy.test.tsx.
 */

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/ai/actions") return Promise.resolve(new Response(JSON.stringify({ actions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
      throw new Error(`unexpected fetch: ${String(input)}`);
    }),
  );
}

/** Mounted like AppShell: the help dialog stays mounted, open state and start page are controlled by outer state, and there is a tour context outside. */
function renderHost(start: () => void) {
  stubFetch();
  let setOpen: (open: boolean, page?: ShortcutsStartPage) => void = () => {};
  function Host() {
    const [open, setOpenState] = useState(false);
    const [page, setPage] = useState<ShortcutsStartPage>("global");
    setOpen = (next, nextPage) => {
      if (nextPage) setPage(nextPage);
      setOpenState(next);
    };
    return <ShortcutsDialog open={open} onOpenChange={setOpenState} returnFocusRef={createRef<HTMLElement>()} page={page} />;
  }
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <TourContext.Provider value={{ start }}>
          <Host />
        </TourContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { setOpen: (open: boolean, page?: ShortcutsStartPage) => act(() => setOpen(open, page)) };
}

function renderOpen(onOpenChange: (open: boolean) => void = () => {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/ai/actions") return Promise.resolve(new Response(JSON.stringify({ actions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
      throw new Error(`unexpected fetch: ${String(input)}`);
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ShortcutsDialog open onOpenChange={onOpenChange} returnFocusRef={createRef<HTMLElement>()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ShortcutsDialog + ShortcutsContent", () => {
  it("first open (chunk still downloading): the dialog has a name first; once the content arrives focus lands in the right card's content area and the name is \"General\"", async () => {
    renderOpen();
    expect(await screen.findByRole("dialog", { name: "Help" })).toBeInTheDocument();
    const region = await screen.findByRole("region", { name: "General" });
    await waitFor(() => expect(region).toHaveFocus());
  });

  it("Tab cycles between the content area and the close button (the left column's category buttons and the narrow-screen back button sit between)", async () => {
    renderOpen();
    const region = await screen.findByRole("region", { name: "General" });
    await waitFor(() => expect(region).toHaveFocus());
    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.keyDown(region, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(region).toHaveFocus();
  });

  it("DOM order: close button -> left column category buttons -> right card content area (the opening landing point and Tab cycling depend on it)", async () => {
    renderOpen();
    const region = await screen.findByRole("region", { name: "General" });
    const dialog = screen.getByRole("dialog", { name: "Help" });
    const close = within(dialog).getByRole("button", { name: "Close" });
    const firstCategory = within(dialog).getByRole("button", { name: "General" });
    const order = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(order(close, firstCategory)).toBe(true);
    expect(order(firstCategory, region)).toBe(true);
  });

  it("choosing a category: the dialog stays open and the right card switches to that category (Esc closes it)", async () => {
    const onOpenChange = vi.fn();
    renderOpen(onOpenChange);
    await screen.findByRole("region", { name: "General" });
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    expect(await screen.findByRole("region", { name: "Columns" })).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("start page on the feature tour, pressing Start tour: the help dialog closes and start is called once", async () => {
    const start = vi.fn();
    const host = renderHost(start);
    await host.setOpen(true, "tour");
    expect(await screen.findByRole("dialog", { name: "Help" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Start tour" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("switching from the General page to Feature tour and pressing Start tour: the help dialog closes and start is called once", async () => {
    const start = vi.fn();
    const host = renderHost(start);
    await host.setOpen(true, "global");
    await screen.findByRole("region", { name: "General" });
    fireEvent.click(screen.getByRole("button", { name: "Feature tour" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start tour" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("reopening on General before the close animation has finished (content still mounted): starts on General this time, not the previous page", async () => {
    // jsdom has no animation: make the dialog content look like it has a close animation, so Radix waits for animationend before unmounting and the content stays on screen.
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
      const real = realGetComputedStyle(el, pseudo);
      if (!el.hasAttribute("data-shortcuts-dialog")) return real;
      return new Proxy(real, {
        get: (target, key) => (key === "animationName" ? `dialog-${el.getAttribute("data-state")}` : Reflect.get(target, key, target)),
      });
    });
    const host = renderHost(vi.fn());
    await host.setOpen(true, "tour");
    await screen.findByRole("region", { name: "Feature tour" });
    await host.setOpen(false);
    expect(document.querySelector("[data-shortcuts-dialog]")).toHaveAttribute("data-state", "closed");
    await host.setOpen(true, "global");
    expect(await screen.findByRole("region", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "General" })).toHaveAttribute("aria-current", "true");
  });
});

describe("phone (< 640)", () => {
  it("opening stays on the category list with focus on the list's back arrow: inside the dialog, and the card it is in is not the hidden layer (the content area is in the hidden card and gets no focus)", async () => {
    stubLayoutTier("phone");
    renderOpen();
    const dialog = await screen.findByRole("dialog", { name: "Help" });
    const back = await within(dialog).findByRole("button", { name: "Close" });
    await waitFor(() => expect(back).toHaveFocus());
    const active = document.activeElement as HTMLElement;
    expect(dialog.contains(active)).toBe(true);
    expect(active.closest("[data-shortcuts-card]")?.className).not.toMatch(/(^| )hidden( |$)/);
    const content = dialog.querySelector<HTMLElement>("[data-shortcuts-content]")!;
    expect(content.closest("[data-shortcuts-card]")?.className).toMatch(/(^| )hidden( |$)/);
  });
});
