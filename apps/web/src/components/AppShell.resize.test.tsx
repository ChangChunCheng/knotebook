import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppShell } from "./AppShell";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { SIDEBAR_WIDTH_DEFAULT } from "@/components/sidebar-width";

const DEFAULT_PX = `${SIDEBAR_WIDTH_DEFAULT}px`;
// Width after dragging 80px right from the default (clientX 100 -> 180).
const DRAGGED = SIDEBAR_WIDTH_DEFAULT + 80;
const DRAGGED_PX = `${DRAGGED}px`;

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/auth/me") {
        return Promise.resolve(fakeResponse({ ok: false, status: 401 }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

const KEY = "sidebar.width";

async function renderShell() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/"]}>
          <AppShell>content</AppShell>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  await screen.findByText("content");
  const handle = screen.getByRole("separator", { name: "Resize sidebar" });
  const aside = handle.closest("aside");
  if (!aside) throw new Error("resize handle is not inside the sidebar <aside>");
  return { handle, aside };
}

/**
 * Assertions are on state/attributes only: jsdom has no CSS, no layout and no `setPointerCapture` (stubbed here with a spy), so "the cursor leaving the handle still tracks", "the handle really overlaps `gap-3`" and "the line is visible on focus" can only be checked by hand.
 */
describe("AppShell sidebar width handle", () => {
  let setPointerCapture: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
    window.localStorage.removeItem(KEY);
    setPointerCapture = vi.fn();
    Element.prototype.setPointerCapture = setPointerCapture;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (Element.prototype as Partial<Element>).setPointerCapture;
    window.localStorage.removeItem(KEY);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.documentElement.removeAttribute("data-accent");
  });

  it("default: 320px, aria-valuenow/min/max, focusable, handle inside the aside (handle position is a class assertion)", async () => {
    const { handle, aside } = await renderShell();

    expect(aside.style.width).toBe(DEFAULT_PX);
    expect(handle).toHaveAttribute("aria-valuenow", String(SIDEBAR_WIDTH_DEFAULT));
    expect(handle).toHaveAttribute("aria-valuemin", "200");
    expect(handle).toHaveAttribute("aria-valuemax", "480");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle.tabIndex).toBe(0);
    expect(aside.contains(handle)).toBe(true);
    // Class assertion, not behaviour: jsdom has no layout, so it can't measure whether the handle really overlaps gap-3.
    expect(handle).toHaveClass("absolute", "left-full", "w-3", "cursor-col-resize");
  });

  it("drag: clamped to min/max, body locked while dragging, written only on release", async () => {
    const { handle, aside } = await renderShell();

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(document.body.style.userSelect).toBe("none");
    expect(document.body.style.cursor).toBe("col-resize");

    fireEvent.pointerMove(handle, { clientX: 180, pointerId: 1 });
    expect(aside.style.width).toBe(DRAGGED_PX);
    expect(handle).toHaveAttribute("aria-valuenow", String(DRAGGED));
    expect(window.localStorage.getItem(KEY)).toBeNull();

    fireEvent.pointerMove(handle, { clientX: 5000, pointerId: 1 });
    expect(aside.style.width).toBe("480px");

    fireEvent.pointerMove(handle, { clientX: -5000, pointerId: 1 });
    expect(aside.style.width).toBe("200px");
    expect(window.localStorage.getItem(KEY)).toBeNull();

    fireEvent.pointerUp(handle, { clientX: -5000, pointerId: 1 });
    expect(window.localStorage.getItem(KEY)).toBe("200");
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");

    // The drag has ended: later moves don't change the width. clientX is deliberately 180: if the drag hadn't ended it would give default + 80, which differs from the clamped minimum 200.
    fireEvent.pointerMove(handle, { clientX: 180, pointerId: 1 });
    expect(aside.style.width).toBe("200px");
  });

  it("pointercancel also finishes: written, body restored, later moves don't change the width", async () => {
    const { handle, aside } = await renderShell();

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 180, pointerId: 1 });
    expect(aside.style.width).toBe(DRAGGED_PX);

    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(window.localStorage.getItem(KEY)).toBe(String(DRAGGED));
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");

    fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1 });
    expect(aside.style.width).toBe(DRAGGED_PX);
  });

  it("lostpointercapture also finishes (the system takes the capture away, no pointerup/cancel)", async () => {
    const { handle, aside } = await renderShell();

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 180, pointerId: 1 });
    expect(aside.style.width).toBe(DRAGGED_PX);

    fireEvent.lostPointerCapture(handle, { pointerId: 1 });
    expect(window.localStorage.getItem(KEY)).toBe(String(DRAGGED));
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");

    fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1 });
    expect(aside.style.width).toBe(DRAGGED_PX);
  });

  it.each([
    [1, "middle"],
    [2, "right"],
  ])("button=%i (%s): pointerdown doesn't start a drag", async (button) => {
    const { handle, aside } = await renderShell();

    fireEvent.pointerDown(handle, { button, clientX: 100, pointerId: 1 });
    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(document.body.style.userSelect).toBe("");

    fireEvent.pointerMove(handle, { clientX: 180, pointerId: 1 });
    expect(aside.style.width).toBe(DEFAULT_PX);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("handle line: transparent normally, hover draws no line, only keyboard focus and dragging show it (class/attribute contract, not behaviour)", async () => {
    // hover only changes the cursor, draws no line. jsdom has no CSS, so only class strings and attributes can be pinned.
    const { handle } = await renderShell();
    const line = handle.firstElementChild;
    if (!line) throw new Error("resize handle has no line element");
    expect(line).toHaveAttribute("aria-hidden", "true");
    expect(handle.className).not.toMatch(/hover/);
    expect(line.className).not.toMatch(/hover/);
    expect(line).toHaveClass("group-focus-visible/resize:bg-ring", "group-data-[dragging]/resize:bg-ring");

    // `group-data-[dragging]` matches on attribute presence, so the attribute must be absent normally:
    // `data-dragging={dragging}` renders as "false" (present) in React, which would keep the line always on.
    expect(handle).not.toHaveAttribute("data-dragging");
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    expect(handle).toHaveAttribute("data-dragging");
    fireEvent.pointerUp(handle, { clientX: 100, pointerId: 1 });
    expect(handle).not.toHaveAttribute("data-dragging");
  });

  it("keyboard: left/right 16px, Home/End, no movement past the limit, written every time", async () => {
    const { handle, aside } = await renderShell();

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(aside.style.width).toBe(`${SIDEBAR_WIDTH_DEFAULT + 16}px`);
    expect(window.localStorage.getItem(KEY)).toBe(String(SIDEBAR_WIDTH_DEFAULT + 16));

    fireEvent.keyDown(handle, { key: "Home" });
    expect(aside.style.width).toBe("200px");
    expect(window.localStorage.getItem(KEY)).toBe("200");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(aside.style.width).toBe("200px");

    fireEvent.keyDown(handle, { key: "End" });
    expect(aside.style.width).toBe("480px");
    expect(window.localStorage.getItem(KEY)).toBe("480");

    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(aside.style.width).toBe("480px");
    expect(handle).toHaveAttribute("aria-valuenow", "480");
  });

  it("double-click resets to the default and clears the stored value", async () => {
    const { handle, aside } = await renderShell();

    fireEvent.keyDown(handle, { key: "End" });
    expect(window.localStorage.getItem(KEY)).toBe("480");

    fireEvent.doubleClick(handle);
    expect(aside.style.width).toBe(DEFAULT_PX);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("stored old default 256 -> stays 256px, not changed to the new default", async () => {
    window.localStorage.setItem(KEY, "256");
    const { aside } = await renderShell();
    expect(aside.style.width).toBe("256px");
  });

  it.each([
    ["abc", DEFAULT_PX],
    ["9999", DEFAULT_PX],
    ["150", DEFAULT_PX],
    ["300.5", DEFAULT_PX],
    ["", DEFAULT_PX],
    ["300", "300px"],
  ])("reading %j -> %s", async (raw, expected) => {
    window.localStorage.setItem(KEY, raw);
    const { aside, handle } = await renderShell();
    expect(aside.style.width).toBe(expected);
    expect(handle).toHaveAttribute("aria-valuenow", expected.replace("px", ""));
  });

  it("sidebar.width read throws -> default width, page still renders", async () => {
    // Throw only for sidebar.width: theme.tsx reads its own key without try/catch, so throwing for everything would blow up in ThemeProvider first.
    const original = Storage.prototype.getItem;
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      if (key === KEY) throw new Error("storage blocked");
      return original.call(this, key);
    });
    const { aside } = await renderShell();
    expect(spy).toHaveBeenCalledWith(KEY);
    expect(aside.style.width).toBe(DEFAULT_PX);
    expect(screen.getByText("content")).toBeInTheDocument();
  });
});
