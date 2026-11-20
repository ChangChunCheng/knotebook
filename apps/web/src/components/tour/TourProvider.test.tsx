import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams, type NavigateFunction } from "react-router";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, toast, Toaster } from "@/components/ui/toast";
import { SidebarQueryProvider } from "@/lib/sidebar-query";
import { notifyEditorEditable, registerEditor, registerShellControls, type TourEditor } from "@/lib/tour-bridge";
import { useTour, type TourApi } from "@/lib/tour-context";
import { OWNER_PERMS } from "@/test/fixtures";
import { seedSampleNote } from "./sample-note";
import { START_TIMEOUT_MS, TourProvider } from "./TourProvider";

// The sample-content write is replaced with a stand-in: this file checks when the start flow calls it and how its result decides whether the note stays; the write itself is covered in sample-note.test.ts.
vi.mock("./sample-note", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sample-note")>();
  return { ...actual, seedSampleNote: vi.fn(() => true) };
});
const seed = vi.mocked(seedSampleNote);

// Counts toasts: wraps the real `toast`, so they still appear on screen.
vi.mock("@/components/ui/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/toast")>();
  return { ...actual, toast: vi.fn(actual.toast) };
});
const toastSpy = vi.mocked(toast);

function noteDto(id: string, title: string, slug: string): NoteDto {
  return {
    id,
    title,
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug,
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
  };
}

const SAMPLE = noteDto("77777777-7777-7777-7777-777777777777", "Welcome to Knotebook", "welcome-to-knotebook");
const OTHER = noteDto("88888888-8888-8888-8888-888888888888", "Groceries", "groceries");
const ELSEWHERE = noteDto("99999999-9999-9999-9999-999999999999", "Recipes", "recipes");
const NOTES = [SAMPLE, OTHER, ELSEWHERE];
const SAMPLE_PATH = canonicalNotePath(SAMPLE);
const OTHER_PATH = canonicalNotePath(OTHER);
const ELSEWHERE_PATH = canonicalNotePath(ELSEWHERE);

const START_FAILED = "The feature tour couldn't start. Try again.";
const SAMPLE_FAILED = "Couldn't create the sample note. Try again.";


interface Call {
  method: string;
  url: string;
  at: string; // location when the request was sent
}

let calls: Call[] = [];
let postStatus = 200;
let postGate: Promise<void> | null = null;
let aiGate: Promise<void> | null = null;
let steps: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, at: currentPath });
      if (url === "/api/notes" && method === "POST") {
        steps.push(`POST drawer=${document.querySelector("[data-sidebar-drawer]") !== null}`);
        if (postGate !== null) await postGate;
        return postStatus === 200 ? json(SAMPLE) : json({ error: { code: "internal", message: "x" } }, postStatus);
      }
      if (url === "/api/notes") return json(NOTES);
      if (url === "/api/ai/actions") {
        if (aiGate !== null) await aiGate;
        return json({ actions: [] });
      }
      if (url.startsWith("/api/notes/") && method === "DELETE") return new Response(null, { status: 204 });
      return json({ error: { code: "not_found", message: url } }, 404);
    }),
  );
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}


let currentPath = "";
let routerNavigate: NavigateFunction | null = null;
let tour: TourApi | null = null;
/** Whether the note page's fake editor is editable when mounted; false = never editable (collab cannot connect). */
let editable = true;
/** Whether the target of stop 1 (the sidebar tab list) has a size; false = stop 1 never becomes ready. */
let targetVisible = true;

function Probe() {
  const location = useLocation();
  currentPath = location.pathname + location.search;
  routerNavigate = useNavigate();
  tour = useTour();
  useEffect(() => {
    steps.push(`at ${location.pathname}`);
  }, [location.pathname]);
  return null;
}

function Drawer() {
  const [open, setOpen] = useState(true);
  useEffect(
    () =>
      registerShellControls({
        showTab: () => {},
        endSelectionIfActive: () => false,
        closeDrawer: () => {
          steps.push("closeDrawer");
          setOpen(false);
        },
        getTab: () => "myNotes",
      }),
    [],
  );
  return open ? <div data-sidebar-drawer="" /> : null;
}

function NoteStandIn() {
  const { slug } = useParams();
  const note = NOTES.find((n) => n.slug === slug)!;
  useEffect(() => {
    const editor = { isEditable: editable, document: [], _tiptapEditor: {} } as unknown as TourEditor;
    const unregister = registerEditor(note.id, editor);
    if (editable) notifyEditorEditable(note.id, editor);
    return unregister;
  }, [note.id]);
  return (
    <main>
      <div data-kb-tour-target="tabs" />
      <input data-note-title-input="" aria-label="Note title" defaultValue={note.title} />
    </main>
  );
}

let queryClient: QueryClient;

function renderHost(initial = OTHER_PATH, { drawer = false } = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initial]}>
        <SidebarQueryProvider>
          <TourProvider>
            {drawer && <Drawer />}
            <Routes>
              <Route path="/" element={<main>Home</main>} />
              <Route path="/n/:handle/:slug" element={<NoteStandIn />} />
            </Routes>
            <Probe />
          </TourProvider>
        </SidebarQueryProvider>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
}

/** After the tour ends, focus lands on the `<main>` of the page returned to (if it is not found the wait runs a full second before giving up). */
function start(returnTo = currentPath) {
  act(() => tour!.start({ returnTo, returnFocus: () => document.querySelector("main") }));
}

const overlay = () => document.querySelector("[data-tour-overlay]");
const posts = () => calls.filter((c) => c.method === "POST" && c.url === "/api/notes");
const deletes = () => calls.filter((c) => c.method === "DELETE");
const aiReads = () => calls.filter((c) => c.url === "/api/ai/actions");
const toastCount = (text: string) => screen.queryAllByText(text).length;
const toastTitles = () => toastSpy.mock.calls.map(([item]) => item.title);

function useFakeClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  calls = [];
  steps = [];
  postStatus = 200;
  postGate = null;
  aiGate = null;
  editable = true;
  targetVisible = true;
  tour = null;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  dismissAllToasts();
  toastSpy.mockClear();
  seed.mockReset();
  seed.mockImplementation(() => true);
  stubFetch();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.getAttribute("data-kb-tour-target") === "tabs" && targetVisible) return new DOMRect(10, 10, 100, 30);
    return new DOMRect(0, 0, 0, 0);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  routerNavigate = null;
});

describe("does not appear on its own", () => {
  it("TourProvider mounted and nobody calls start: no note created, no AI actions read, no overlay", async () => {
    renderHost();
    await new Promise((r) => setTimeout(r, 300));
    expect(tour).not.toBeNull();
    expect(posts()).toEqual([]);
    expect(aiReads()).toEqual([]);
    expect(overlay()).toBeNull();
  });
});

describe("start", () => {
  it("closes the drawer and waits for it to disappear, then creates the sample note and navigates to it; stop 1 appears on the sample note", async () => {
    renderHost(OTHER_PATH, { drawer: true });
    steps = [];
    start();
    await screen.findByRole("dialog", { name: "Sidebar sections" });
    expect(steps).toEqual(["closeDrawer", "POST drawer=false", `at ${SAMPLE_PATH}`]);
    expect(currentPath).toBe(SAMPLE_PATH);
    expect(seed).toHaveBeenCalledTimes(1);
    expect(seed.mock.calls[0]![1]).toEqual(SAMPLE);
    // no AI actions on the site, so the sample omits the AI sentence
    expect(seed.mock.calls[0]![3]).toBe(false);
    expect(aiReads()).toHaveLength(1);
  });

  it("sample-note creation fails -> one creation-failure toast, no overlay, no extra start-failure toast; it can be started again afterwards", async () => {
    postStatus = 500;
    renderHost();
    start();
    await screen.findByText(SAMPLE_FAILED);
    await new Promise((r) => setTimeout(r, 200));
    expect(toastCount(SAMPLE_FAILED)).toBe(1);
    expect(toastCount(START_FAILED)).toBe(0);
    expect(overlay()).toBeNull();
    expect(currentPath).toBe(OTHER_PATH);

    postStatus = 200;
    start();
    await screen.findByRole("dialog", { name: "Sidebar sections" });
    expect(posts()).toHaveLength(2);
  });

  it("calling start while running does nothing (no second note)", async () => {
    postGate = gate().promise;
    renderHost();
    start();
    await waitFor(() => expect(posts()).toHaveLength(1));
    start();
    start();
    await new Promise((r) => setTimeout(r, 200));
    expect(posts()).toHaveLength(1);
  });

  it("can be started again after a normal finish, each time creating a new note", async () => {
    renderHost();
    start();
    await screen.findByRole("dialog", { name: "Sidebar sections" });
    act(() => screen.getByRole("button", { name: "Close" }).click());
    await waitFor(() => expect(overlay()).toBeNull());
    await waitFor(() => expect(currentPath).toBe(OTHER_PATH));
    await waitFor(() => expect(document.activeElement?.tagName).toBe("MAIN"));
    start();
    await screen.findByRole("dialog", { name: "Sidebar sections" });
    expect(posts()).toHaveLength(2);
    expect(deletes()).toEqual([]);
  });
});

describe("aborting the start flow", () => {
  it("location leaves the sample note while waiting for editability -> one toast, the empty sample note goes to the trash; starting again creates a fresh note", async () => {
    editable = false;
    renderHost();
    start();
    await waitFor(() => expect(currentPath).toBe(SAMPLE_PATH));
    act(() => void routerNavigate!(ELSEWHERE_PATH));
    await screen.findByText(START_FAILED);
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(deletes()[0]!.url).toBe(`/api/notes/${SAMPLE.id}`);
    expect(seed).not.toHaveBeenCalled();
    expect(currentPath).toBe(ELSEWHERE_PATH);
    expect(overlay()).toBeNull();
    await waitFor(() => expect(document.activeElement?.tagName).toBe("MAIN"));

    editable = true;
    start();
    await screen.findByRole("dialog", { name: "Sidebar sections" });
    expect(posts()).toHaveLength(2);
    expect(toastCount(START_FAILED)).toBe(1);
  });

  it("editor never becomes editable -> 15 s timeout: one toast only, navigates back before trashing, the in-progress flag is cleared so it can start again", async () => {
    useFakeClock();
    editable = false;
    renderHost();
    start(OTHER_PATH);
    await waitFor(() => expect(currentPath).toBe(SAMPLE_PATH));
    // Advance the timers without `act()`: React then commits normal updates first (closing the tour) as in a browser, and the navigation transition commits later.
    // With `act()` both flush together at the end, and the wrong order ("trash request sent while still on the sample note") would go unnoticed.
    // Timers also follow real time (`shouldAdvanceTime`): the 2 s margin keeps the real time spent cold-loading the tour chunk from expiring the timeout early.
    vi.advanceTimersByTime(START_TIMEOUT_MS - 2_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(toastCount(START_FAILED)).toBe(0);
    vi.advanceTimersByTime(2_100);
    await screen.findByText(START_FAILED);
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(deletes()[0]!.at).toBe(OTHER_PATH);
    expect(currentPath).toBe(OTHER_PATH);
    expect(toastTitles()).toEqual([START_FAILED]);
    expect(seed).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement?.tagName).toBe("MAIN"));

    editable = true;
    start(OTHER_PATH);
    await screen.findByRole("dialog", { name: "Sidebar sections" });
    expect(posts()).toHaveLength(2);
  });

  it("writing sample content throws -> one toast, back to the original page, note trashed, focus returns to the element found by returnFocus", async () => {
    seed.mockImplementation(() => {
      throw new TypeError("bad block");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderHost();
    start(OTHER_PATH);
    await screen.findByText(START_FAILED);
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(deletes()[0]!.at).toBe(OTHER_PATH);
    expect(currentPath).toBe(OTHER_PATH);
    expect(toastCount(START_FAILED)).toBe(1);
    expect(overlay()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector("main")));
  });

  it("timeout while reading AI actions -> the read returning later does not write either, note trashed", async () => {
    useFakeClock();
    const ai = gate();
    aiGate = ai.promise;
    renderHost();
    start(OTHER_PATH);
    await waitFor(() => expect(currentPath).toBe(SAMPLE_PATH));
    await waitFor(() => expect(aiReads()).toHaveLength(1));
    act(() => vi.advanceTimersByTime(START_TIMEOUT_MS));
    await screen.findByText(START_FAILED);
    ai.release();
    await waitFor(() => expect(deletes()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(seed).not.toHaveBeenCalled();
    expect(deletes()).toHaveLength(1);
    expect(overlay()).toBeNull();
  });

  it("timeout before the create-note request returns -> after it returns there is no navigation and the note goes straight to the trash", async () => {
    useFakeClock();
    const post = gate();
    postGate = post.promise;
    renderHost();
    start(OTHER_PATH);
    await waitFor(() => expect(posts()).toHaveLength(1));
    act(() => vi.advanceTimersByTime(START_TIMEOUT_MS));
    await screen.findByText(START_FAILED);
    post.release();
    await waitFor(() => expect(deletes()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(currentPath).toBe(OTHER_PATH);
    expect(steps).not.toContain(`at ${SAMPLE_PATH}`);
    expect(seed).not.toHaveBeenCalled();
  });

  it("timeout after the write returned false (someone else's content is already there) -> one toast, note kept, no navigation", async () => {
    useFakeClock();
    seed.mockImplementation(() => false);
    targetVisible = false;
    renderHost();
    start(OTHER_PATH);
    await waitFor(() => expect(seed).toHaveBeenCalledTimes(1));
    act(() => vi.advanceTimersByTime(START_TIMEOUT_MS));
    await screen.findByText(START_FAILED);
    await new Promise((r) => setTimeout(r, 200));
    expect(deletes()).toEqual([]);
    expect(currentPath).toBe(SAMPLE_PATH);
    expect(overlay()).toBeNull();
  });

  it("no timeout once stop 1 has appeared: after 15 s the tour is still open", async () => {
    useFakeClock();
    renderHost();
    start(OTHER_PATH);
    await screen.findByRole("dialog", { name: "Sidebar sections" });
    act(() => vi.advanceTimersByTime(START_TIMEOUT_MS * 2));
    await new Promise((r) => setTimeout(r, 100));
    expect(toastCount(START_FAILED)).toBe(0);
    expect(screen.getByRole("dialog", { name: "Sidebar sections" })).toBeTruthy();
    expect(deletes()).toEqual([]);
  });
});
