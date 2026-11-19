import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import * as Y from "yjs";
import { blocksToYDoc } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { FakeReveal } from "@/test/fake-reveal";
import { installFakeFullscreen, type FakeFullscreen } from "@/test/fake-fullscreen";
import { createExportEditor, renderDeck } from "@/present/render";
import PublicNotePage from "./PublicNotePage";

vi.mock("reveal.js", async () => ({ default: (await import("@/test/fake-reveal")).FakeReveal }));
vi.mock("@/lib/mermaid", () => ({ renderMermaid: vi.fn(async () => ({ ok: true, svg: "<svg></svg>" })) }));
vi.mock("@/components/PublicNoteEditor", () => ({ PublicNoteEditor: () => <div data-testid="public-note-editor" /> }));
vi.mock("@/present/render", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/present/render")>();
  return { ...mod, renderDeck: vi.fn(mod.renderDeck) };
});
const nav = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("react-router", async (importOriginal) => {
  const mod = await importOriginal<typeof import("react-router")>();
  const { useMemo } = await import("react");
  return {
    ...mod,
    useNavigate: () => {
      const real = mod.useNavigate();
      // useMemo: the wrapper's identity is as stable as the real one (like the real useNavigate); otherwise code that puts navigate in effect deps would rerun on every render
      return useMemo(
        () =>
          ((...args: Parameters<typeof real>) => {
            nav.fn(...args);
            return real(...args);
          }) as typeof real,
        [real],
      );
    },
  };
});

const TOKEN = "abcDEF123_-".repeat(4).slice(0, 43);

function ydocBase64(blocks: unknown[]): string {
  const doc = blocksToYDoc(createExportEditor(), blocks as never, YDOC_FRAGMENT);
  const bytes = Y.encodeStateAsUpdate(doc);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const V1 = [
  { id: "a", type: "heading", props: { level: 2 }, content: "A" },
  { id: "b", type: "heading", props: { level: 2 }, content: "B" },
];
const V2 = [
  { id: "a", type: "heading", props: { level: 2 }, content: "A" },
  { id: "n", type: "heading", props: { level: 2 }, content: "New before B" },
  { id: "b", type: "heading", props: { level: 2 }, content: "B" },
];

// Only public endpoints are answered; anything else throws, because an anonymous page must not call authenticated APIs.
const server = vi.hoisted(() => ({ status: 200, body: null as unknown, calls: [] as string[] }));
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      server.calls.push(`${method} ${url}`);
      if (method !== "GET" || url !== `/api/public/notes/${TOKEN}`) throw new Error(`unexpected fetch: ${method} ${url}`);
      return Promise.resolve({
        ok: server.status === 200,
        status: server.status,
        // Return a **new** object each time (structuredClone), equivalent to a real browser parsing JSON each time - returning the same
        // reference would make turning off structural sharing indistinguishable, and this case could not detect it.
        json: () => Promise.resolve(server.status === 200 ? structuredClone(server.body) : { error: { code: server.status === 404 ? "not_found" : "internal", message: "x" } }),
      } as unknown as Response);
    }),
  );
}

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="loc">{`${location.pathname}${location.search}${location.hash}`}</div>
      <button type="button" onClick={() => navigate(`/p/${TOKEN}?present#/b`)}>
        go-present
      </button>
    </>
  );
}

function renderPublic(entry: string) {
  window.history.replaceState(null, "", entry);
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Probe />
          <Routes>
            <Route path="/p/:token" element={<PublicNotePage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

const ready = async () => {
  await waitFor(() => expect(FakeReveal.instances.length).toBeGreaterThan(0));
  const deck = FakeReveal.instances.at(-1)!;
  await waitFor(() => expect(deck.listenerCount("slidechanged")).toBe(1)); // ready (see fake-reveal.ts)
  return deck;
};

describe("public page x presentation", () => {
  let fake: FakeFullscreen | null = null;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    FakeReveal.reset();
    nav.fn.mockClear();
    vi.mocked(renderDeck).mockClear();
    server.status = 200;
    server.body = { title: "Public Note", ydoc: ydocBase64(V1) };
    server.calls = [];
    stubFetch();
  });

  afterEach(async () => {
    await fake?.uninstall();
    fake = null;
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("the header presentation-mode button -> pushes ?present (with the flag), requestFullscreen comes before the navigation, the shell appears", async () => {
    fake = installFakeFullscreen();
    renderPublic(`/p/${TOKEN}`);
    fireEvent.click(await screen.findByRole("button", { name: "Present" }));
    expect(nav.fn).toHaveBeenCalledWith({ pathname: `/p/${TOKEN}`, search: "?present", hash: "" }, { state: { knotebookPresentPushed: true } });
    expect(fake.requestFullscreen.mock.invocationCallOrder[0]).toBeLessThan(nav.fn.mock.invocationCallOrder[0]);
    expect(await screen.findByRole("dialog", { name: "Public Note — presentation" })).toBeInTheDocument();
  });

  it("during presentation only public endpoints are hit (not /api/auth/me or /api/notes)", async () => {
    renderPublic(`/p/${TOKEN}?present`);
    await ready();
    expect(new Set(server.calls)).toEqual(new Set([`GET /api/public/notes/${TOKEN}`]));
  });

  it("PublicPageFrame root has inert; neither the shell nor any ancestor of the overlay does", async () => {
    renderPublic(`/p/${TOKEN}?present`);
    const deck = await ready();
    expect(screen.getByTestId("public-note-editor").closest("[inert]")).not.toBeNull();
    expect(screen.getByRole("dialog").closest("[inert]")).toBeNull();
    expect(deck.el.closest("[inert]")).toBeNull();
  });

  it("a refetch that brings a new Y.Doc with different content -> re-split after debounce, stays on the same slide (b's new index)", async () => {
    const queryClient = renderPublic(`/p/${TOKEN}?present`);
    const deck = await ready();
    act(() => deck.slide(2, 0)); // b
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe(`/p/${TOKEN}?present#/b`));
    const calls = vi.mocked(renderDeck).mock.calls.length;
    server.body = { title: "Public Note", ydoc: ydocBase64(V2) };
    await act(async () => queryClient.invalidateQueries());
    await waitFor(() => expect(vi.mocked(renderDeck).mock.calls.length).toBe(calls + 1));
    await waitFor(() => expect(deck.slide).toHaveBeenLastCalledWith(3, 0));
    expect(screen.getByTestId("loc").textContent).toBe(`/p/${TOKEN}?present#/b`);
  });

  it("a refetch with identical data does not re-split (react-query structural sharing keeps the doc unchanged)", async () => {
    const queryClient = renderPublic(`/p/${TOKEN}?present`);
    await ready();
    const calls = vi.mocked(renderDeck).mock.calls.length;
    await act(async () => queryClient.invalidateQueries());
    await waitFor(() => expect(server.calls.length).toBeGreaterThanOrEqual(2));
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(vi.mocked(renderDeck).mock.calls.length).toBe(calls);
  });

  it("refetch 404 -> the presentation layer unmounts, shows the invalid card, leaves our fullscreen", async () => {
    fake = installFakeFullscreen();
    const queryClient = renderPublic(`/p/${TOKEN}?present`);
    await ready();
    const { enterPresentationFullscreen } = await import("@/present/fullscreen");
    enterPresentationFullscreen();
    await act(async () => fake!.grantEventFirst());
    server.status = 404;
    await act(async () => queryClient.invalidateQueries());
    expect(await screen.findByText("This link doesn't exist or is no longer active.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fake.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("#234 refetch 404 -> the URL drops ?present and the slide hash; navigates by replace, no new history entry", async () => {
    const queryClient = renderPublic(`/p/${TOKEN}?present#/b`);
    await ready();
    nav.fn.mockClear();
    server.status = 404;
    await act(async () => queryClient.invalidateQueries());
    expect(await screen.findByText("This link doesn't exist or is no longer active.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe(`/p/${TOKEN}`));
    const stripCalls = nav.fn.mock.calls.filter(([to]) => typeof to === "object" && to !== null);
    expect(stripCalls).toEqual([[{ pathname: `/p/${TOKEN}`, search: "", hash: "" }, { replace: true }]]);
  });

  it("#234 404 first (not presenting), then navigating to ?present#/b -> removed by replace just the same", async () => {
    server.status = 404;
    renderPublic(`/p/${TOKEN}`);
    expect(await screen.findByText("This link doesn't exist or is no longer active.")).toBeInTheDocument();
    nav.fn.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "go-present" }));
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe(`/p/${TOKEN}`));
    const replaceCalls = nav.fn.mock.calls.filter(([, opts]) => (opts as { replace?: boolean } | undefined)?.replace === true);
    expect(replaceCalls).toEqual([[{ pathname: `/p/${TOKEN}`, search: "", hash: "" }, { replace: true }]]);
  });

  it("refetch fails with a non-404 -> the presentation layer is untouched (keeps rendering the snapshot)", async () => {
    const queryClient = renderPublic(`/p/${TOKEN}?present`);
    const deck = await ready();
    server.status = 500;
    await act(async () => queryClient.invalidateQueries());
    await waitFor(() => expect(server.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(deck.destroy).not.toHaveBeenCalled();
  });
});
