import { StrictMode, useLayoutEffect, useReducer, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createPath,
  MemoryRouter,
  NavigationType,
  parsePath,
  Route,
  Router,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  type Location,
  type NavigateFunction,
  type Navigator,
  type To,
} from "react-router";
import { canonicalNotePath, type AiActionDto, type NoteDto, type UserDto } from "@knotebook/shared";
import type { CollabState } from "@/collab/connection";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarQueryProvider } from "@/lib/sidebar-query";
import { getShellControls, registerEditor, type TourEditor } from "@/lib/tour-bridge";
import { useIsPhone } from "@/lib/layout-tiers";
import { findTourTarget, findUserMenuReturnTarget, findUserMenuTrigger } from "@/lib/tour-find";
import { tourTarget, type TourTargetId } from "@/lib/tour-targets";
import { useVersionsController, VersionsProvider } from "@/lib/versions-context";
import { ThemeProvider } from "@/theme";
import { Toaster } from "@/components/ui/toast";
import { AppShell, SidebarDrawerButton } from "@/components/AppShell";
import { BackToListButton } from "@/components/BackToListButton";
import { NoteBrowseBar } from "@/components/NoteBrowseBar";
import { CornerStack } from "@/components/CornerStack";
import { NarrowTopBar } from "@/components/NarrowTopBar";
import { NoteMenu } from "@/components/NoteMenu";
import { ShareDialog } from "@/components/ShareDialog";
import { OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { HOLE_PADDING } from "./geometry";
import { SCREEN_TIMEOUT_MS, TARGET_TIMEOUT_MS, waitForFrames, type TourStopEntry } from "./engine";
import type { StopContext, StopDef, StopId } from "./stops";
import { TourRunner, type TourRunnerProps } from "./TourRunner";

// The test host mirrors the App wiring: the tour lives outside `<Routes>`; the home and note pages each render their own AppShell (the sidebar is a fresh one after navigation).
// The note page includes the header components (hamburger, share, kebab menu, title box) and the version bubble at the bottom right.

const USER: UserDto = {
  id: "u1",
  email: "a@example.com",
  handle: "tester",
  displayName: "Ann",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

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
const NOTES = [SAMPLE, OTHER];
const SAMPLE_PATH = canonicalNotePath(SAMPLE);
const OTHER_PATH = canonicalNotePath(OTHER);
const CONNECTED: CollabState = { phase: "connected", role: "owner" };
const AI_ACTION: AiActionDto = { id: "rewrite", name: "Rewrite", applyMode: "preview", kind: "quick" };


interface FetchCall {
  method: string;
  url: string;
  at: string; // location when the request was sent
}

let calls: FetchCall[] = [];
let aiActions: AiActionDto[] | "error" = [];
let deleteStatus = 204;
/** When set, `GET /api/ai/actions` blocks until it resolves. */
let aiGate: Promise<void> | null = null;

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
      if (url === "/api/groups") return json([]);
      if (url === "/api/auth/me") return json(USER);
      if (url === "/api/folders") return json(FOLDER_LIST_EMPTY);
      if (url === "/api/notes" && method === "GET") return json(NOTES);
      if (url === "/api/ai/actions") await aiGate;
      if (url === "/api/ai/actions") return aiActions === "error" ? json({ error: { code: "internal", message: "x" } }, 500) : json({ actions: aiActions });
      if (url.startsWith("/api/notes/") && method === "DELETE") {
        return deleteStatus === 204 ? new Response(null, { status: 204 }) : json({ error: { code: "internal", message: "x" } }, deleteStatus);
      }
      return json({ error: { code: "not_found", message: url } }, 404);
    }),
  );
}


// Layout is always switched through `stubLayoutTier`: `docked` = wide window, `overlay` = floating sidebar (640 to 1279), `phone` = phone (narrower than 640).
let tierControl: ReturnType<typeof stubLayoutTier> | null = null;

function stubTier(tier: LayoutTier) {
  tierControl = stubLayoutTier(tier);
}

function stubViewport(narrow: boolean) {
  stubTier(narrow ? "overlay" : "docked");
}

function setTier(tier: LayoutTier) {
  act(() => tierControl!.setLayoutTier(tier));
}

function setNarrow(narrow: boolean) {
  setTier(narrow ? "overlay" : "docked");
}

const RECTS: Record<TourTargetId, [number, number, number, number]> = {
  tabs: [10, 60, 200, 30],
  newNote: [10, 600, 200, 36],
  newFolder: [180, 100, 24, 24],
  search: [10, 20, 200, 30],
  share: [900, 10, 60, 30],
  noteMenu: [970, 10, 30, 30],
  noteWidth: [935, 10, 30, 30],
  versions: [1200, 650, 40, 40],
  userMenu: [10, 650, 200, 40],
  drawerButton: [5, 5, 32, 32],
  backToList: [8, 12, 32, 32],
  phoneNewNote: [320, 760, 56, 56],
  phoneSearch: [16, 760, 56, 56],
  wikilinkMenu: [400, 300, 220, 60],
  slashMenu: [400, 300, 220, 60],
  wikilink: [300, 200, 120, 20],
  flowchart: [300, 400, 400, 120],
};
let hiddenTargets = new Set<TourTargetId>();

function stubRects() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const id = this.getAttribute("data-kb-tour-target") as TourTargetId | null;
    if (id === null || hiddenTargets.has(id)) return new DOMRect(0, 0, 0, 0);
    return new DOMRect(...RECTS[id]);
  });
}

function hole(): { x: number; y: number; width: number; height: number } | null {
  const el = document.querySelector("[data-tour-hole]");
  if (el === null) return null;
  return { x: Number(el.getAttribute("x")), y: Number(el.getAttribute("y")), width: Number(el.getAttribute("width")), height: Number(el.getAttribute("height")) };
}

function padded([left, top, width, height]: [number, number, number, number]) {
  return { x: left - HOLE_PADDING, y: top - HOLE_PADDING, width: width + HOLE_PADDING * 2, height: height + HOLE_PADDING * 2 };
}


let currentPath = "";
let routerNavigate: NavigateFunction | null = null;

function LocationProbe() {
  const location = useLocation();
  currentPath = location.pathname + location.search;
  routerNavigate = useNavigate();
  return null;
}

function HomeStandIn() {
  return (
    <AppShell>
      <NarrowTopBar />
    </AppShell>
  );
}

/** Whether the note page's title box is mounted (removed = the sample note's screen never appears, so a screen change waits forever). */
let noteTitleShown = true;

function NoteStandIn() {
  const { slug } = useParams();
  const note = NOTES.find((n) => n.slug === slug)!;
  const versions = useVersionsController({ noteId: note.id, enabled: true });
  const phone = useIsPhone();
  return (
    <AppShell>
      <VersionsProvider value={versions}>
        <header data-note-id={note.id}>
          <BackToListButton />
          <SidebarDrawerButton />
          {noteTitleShown && <input data-note-title-input="" aria-label="Note title" defaultValue={note.title} />}
          <ShareDialog note={note} />
          <NoteMenu note={note} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} />
        </header>
        <CornerStack />
        {/* Round button at the bottom of the phone note screen (as in NotePage; mounted only on phones). */}
        {phone && <NoteBrowseBar note={note} />}
        {/* A ready-made `[[` link in the sample note (when there is no editor, the live stop points at it). */}
        <a href="/somewhere" {...tourTarget("wikilink")}>
          linked note
        </a>
        {/* A diagram inserted with `/` in the sample note (when there is no editor, the `/` stop points at it). */}
        <div {...tourTarget("flowchart")}>a flowchart</div>
      </VersionsProvider>
    </AppShell>
  );
}

let queryClient: QueryClient;

/**
 * History whose navigations can take effect later: a navigation is recorded first, and in `manual` mode the test calls `commit()` to change location (simulating the gap where BrowserRouter catches up inside a transition).
 * Only what these tests need: push/replace, no go.
 */
class DeferredHistory {
  location: Location;
  type: NavigationType = NavigationType.Pop;
  manual = false;
  readonly calls: { action: NavigationType; pathname: string }[] = [];
  private pending: { action: NavigationType; location: Location }[] = [];
  private seq = 0;
  listener: (() => void) | null = null;

  constructor(initial: string) {
    this.location = this.make(initial);
  }

  private make(to: To, state?: unknown): Location {
    const path = typeof to === "string" ? parsePath(to) : to;
    return { pathname: path.pathname ?? this.location.pathname, search: path.search ?? "", hash: path.hash ?? "", state: state ?? null, key: `k${++this.seq}` };
  }

  private record(action: NavigationType, to: To, state?: unknown): void {
    const location = this.make(to, state);
    this.calls.push({ action, pathname: location.pathname });
    this.pending.push({ action, location });
    if (!this.manual) this.commit();
  }

  commit(): void {
    const last = this.pending.at(-1);
    this.pending = [];
    if (last === undefined) return;
    this.location = last.location;
    this.type = last.action;
    this.listener?.();
  }

  readonly navigator: Navigator = {
    createHref: (to) => (typeof to === "string" ? to : createPath(to)),
    go: () => {},
    push: (to, state) => this.record(NavigationType.Push, to, state),
    replace: (to, state) => this.record(NavigationType.Replace, to, state),
  };
}

function DeferredRouter({ history, children }: { history: DeferredHistory; children: ReactNode }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => {
    history.listener = rerender;
    return () => {
      history.listener = null;
    };
  }, [history]);
  return (
    <Router location={history.location} navigationType={history.type} navigator={history.navigator}>
      {children}
    </Router>
  );
}

function RouterShell({ initial, history, children }: { initial: string; history?: DeferredHistory; children: ReactNode }) {
  return history === undefined ? (
    <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  ) : (
    <DeferredRouter history={history}>{children}</DeferredRouter>
  );
}

function Host({ initial, runner, history }: { initial: string; runner: ReactNode; history?: DeferredHistory }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterShell initial={initial} history={history}>
          <SidebarQueryProvider>
            <ActiveNoteProvider>
              <Routes>
                <Route path="/" element={<HomeStandIn />} />
                <Route path="/n/:handle/:slug" element={<NoteStandIn />} />
                <Route path="/login" element={<main>Login</main>} />
              </Routes>
              {runner}
              <LocationProbe />
            </ActiveNoteProvider>
          </SidebarQueryProvider>
        </RouterShell>
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

/** Follows the start flow: navigates to the sample note and returns once its page is mounted. */
async function fakePrepareSample(signal: AbortSignal): Promise<NoteDto | null> {
  act(() => void routerNavigate!(SAMPLE_PATH));
  const ready = await waitForFrames(() => (document.querySelector(`[data-note-id="${SAMPLE.id}"]`) ? true : null), signal, 5000);
  return ready === null ? null : SAMPLE;
}


interface StartOptions {
  initial?: string;
  returnTo?: string;
  props?: Partial<TourRunnerProps>;
  strict?: boolean;
  before?: () => Promise<void> | void;
  /** Uses a history with deferrable commits instead of MemoryRouter. */
  history?: DeferredHistory;
}

async function startTour({ initial = OTHER_PATH, returnTo = initial, props = {}, strict = false, before, history }: StartOptions = {}) {
  const onFinished = vi.fn();
  const prepareSample = vi.fn(fakePrepareSample);
  const onStarted = vi.fn();
  const runnerProps: TourRunnerProps = { returnTo, returnFocus: findUserMenuReturnTarget, prepareSample, onStarted, onFinished, ...props };
  const wrap = (node: ReactNode) => (strict ? <StrictMode>{node}</StrictMode> : node);
  const view = render(wrap(<Host initial={initial} runner={null} history={history} />));
  await screen.findByRole("button", { name: USER.displayName });
  await before?.();
  const startedWith = { trigger: findUserMenuTrigger() };
  view.rerender(wrap(<Host initial={initial} runner={<TourRunner {...runnerProps} />} history={history} />));
  return {
    ...view,
    onStarted,
    onFinished,
    prepareSample: runnerProps.prepareSample,
    startedWith,
    unmountRunner: () => view.rerender(wrap(<Host initial={initial} runner={null} history={history} />)),
  };
}

const card = () => {
  const el = document.querySelector<HTMLElement>("[data-tour-card]");
  if (el === null) throw new Error("no tour card");
  return el;
};
const findCard = (title: string) => screen.findByRole("dialog", { name: title });
const overlay = () => document.querySelector("[data-tour-overlay]");
const progress = () => within(card()).getByText(/^\d+ \/ \d+$/).textContent;

async function next(expectTitle: string) {
  fireEvent.click(within(card()).getByRole("button", { name: "Next" }));
  await findCard(expectTitle);
}

const FULL_TITLES = ["Sidebar sections", "New note", "Folders", "Search", "Share and more", "Version history", "Link to another note", "Insert blocks with /", "Forgot how something works?"];

async function goToLast() {
  await findCard(FULL_TITLES[0]!);
  for (const title of FULL_TITLES.slice(1)) await next(title);
}

/** Fake stops: the target borrows attributes of real components; `leave` calls can be counted. */
function fakeEntry(id: string, targetId: TourTargetId, extra: Partial<StopDef> = {}): TourStopEntry & { leave: ReturnType<typeof vi.fn> } {
  const leave = vi.fn();
  const stop: StopDef = {
    id: id as StopId,
    titleKey: `fake.${id}`,
    bodyKey: `fake.${id}.body`,
    target: () => {
      const el = findTourTarget(targetId);
      return el === null ? [] : [el];
    },
    leave,
    ...extra,
  };
  return { stop, leave };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  calls = [];
  aiActions = [];
  deleteStatus = 204;
  aiGate = null;
  hiddenTargets = new Set();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  stubFetch();
  stubViewport(false);
  stubRects();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.removeItem("sidebar.tab");
  routerNavigate = null;
});

describe("a full tour round (wide window)", () => {
  it("opened from the note page: nine stops in order, the hole on each stop's target, n / N; finally Keep sample note -> back to the original page, focus on the account row, nothing deleted", async () => {
    const { onFinished } = await startTour();
    await findCard("Sidebar sections");
    expect(currentPath).toBe(SAMPLE_PATH);
    expect(progress()).toBe("1 / 9");
    expect(hole()).toEqual(padded(RECTS.tabs));
    expect(card()).not.toHaveAccessibleDescription(/\{\{/);

    const expected: [string, { x: number; y: number; width: number; height: number }][] = [
      ["New note", padded(RECTS.newNote)],
      ["Folders", padded(RECTS.newFolder)],
      ["Search", padded(RECTS.search)],
      // union of the share button and the kebab menu
      ["Share and more", padded([900, 10, 100, 30])],
      ["Version history", padded(RECTS.versions)],
      ["Link to another note", padded(RECTS.wikilink)],
      ["Insert blocks with /", padded(RECTS.flowchart)],
      ["Forgot how something works?", padded(RECTS.userMenu)],
    ];
    for (const [i, [title, rect]] of expected.entries()) {
      await next(title);
      expect(progress()).toBe(`${i + 2} / 9`);
      await waitFor(() => expect(hole()).toEqual(rect));
      expect(card(), title).not.toHaveAccessibleDescription(/\{\{/);
      if (title === "Search") expect(card()).toHaveAccessibleDescription(/Ctrl\+K/);
    }

    fireEvent.click(within(card()).getByRole("button", { name: "Keep sample note" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(overlay()).toBeNull();
    expect(currentPath).toBe(OTHER_PATH);
    expect(document.activeElement).toBe(findUserMenuTrigger());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: USER.displayName }));
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("one overlay instance for the whole round (no remount on stop changes); the live region announces the new stop on each change", async () => {
    await startTour();
    await findCard("Sidebar sections");
    const root = overlay();
    const announcement = () => document.querySelector("[data-tour-step-announcement]")?.textContent;
    expect(announcement()).toBe("");
    await next("New note");
    expect(overlay()).toBe(root);
    expect(announcement()).toContain("2 / 9");
    expect(announcement()).toContain("New note");
    await next("Folders");
    expect(overlay()).toBe(root);
    expect(document.querySelectorAll("[data-tour-overlay]")).toHaveLength(1);
  });

  it("Back returns to the previous stop", async () => {
    await startTour();
    await findCard("Sidebar sections");
    await next("New note");
    fireEvent.click(within(card()).getByRole("button", { name: "Back" }));
    await findCard("Sidebar sections");
    expect(progress()).toBe("1 / 9");
  });
});

describe("start flow", () => {
  it("no overlay before the sample note is ready; prepareSample receives the abort signal", async () => {
    let release: (note: NoteDto | null) => void = () => {};
    let received: AbortSignal | null = null;
    const prepareSample = vi.fn((signal: AbortSignal) => {
      received = signal;
      return new Promise<NoteDto | null>((resolve) => {
        release = resolve;
      });
    });
    const { unmountRunner } = await startTour({ props: { prepareSample } });
    await waitFor(() => expect(prepareSample).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(overlay()).toBeNull();
    unmountRunner();
    expect(received!.aborted).toBe(true);
    release(null);
  });

  it("prepareSample returns null (cannot start) -> no overlay and one onFinished; AI actions are still read once (issued at the same time as preparing the sample note)", async () => {
    const prepareSample = vi.fn(async () => null);
    const { onFinished } = await startTour({ props: { prepareSample } });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(overlay()).toBeNull();
    expect(calls.filter((c) => c.url === "/api/ai/actions")).toHaveLength(1);
  });

  it("prepareSample returns null -> onStarted is not called and onFinished gets started=false", async () => {
    const prepareSample = vi.fn(async () => null);
    const { onStarted, onFinished } = await startTour({ props: { prepareSample } });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(onFinished).toHaveBeenCalledWith({ started: false, reason: "aborted" });
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("leaving the page while reading AI actions -> stop 1 never appeared: onStarted is not called and onFinished gets started=false", async () => {
    let release: () => void = () => {};
    aiGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { onStarted, onFinished } = await startTour();
    await waitFor(() => expect(calls.some((c) => c.url === "/api/ai/actions")).toBe(true));
    act(() => void routerNavigate!("/login"));
    release();
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(onFinished).toHaveBeenCalledWith({ started: false, reason: "aborted" });
    expect(onStarted).not.toHaveBeenCalled();
    expect(overlay()).toBeNull();
    expect(currentPath).toBe("/login");
  });

  it("leaving the page while waiting for stop 1's target -> onStarted is not called and onFinished gets started=false", async () => {
    hiddenTargets = new Set(["tabs"]);
    const { onStarted, onFinished } = await startTour({ props: { stops: [fakeEntry("one", "tabs"), fakeEntry("two", "userMenu")] } });
    await waitFor(() => expect(calls.some((c) => c.url === "/api/ai/actions")).toBe(true));
    await new Promise((r) => setTimeout(r, 300));
    expect(overlay()).toBeNull();
    expect(onStarted).not.toHaveBeenCalled();
    act(() => void routerNavigate!("/login"));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(onFinished).toHaveBeenCalledWith({ started: false, reason: "aborted" });
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("onStarted is not fired before stop 1's target appears and is fired once after it appears", async () => {
    hiddenTargets = new Set(["tabs"]);
    const { onStarted } = await startTour({ props: { stops: [fakeEntry("one", "tabs"), fakeEntry("two", "userMenu")] } });
    await waitFor(() => expect(calls.some((c) => c.url === "/api/ai/actions")).toBe(true));
    await new Promise((r) => setTimeout(r, 300));
    expect(overlay()).toBeNull();
    expect(onStarted).not.toHaveBeenCalled();
    hiddenTargets = new Set();
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 300));
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("onStarted fires once when stop 1 appears: changing stops, going back and re-rendering do not call it again; a normal finish has started=true", async () => {
    const { onStarted, onFinished } = await startTour();
    await findCard("Sidebar sections");
    expect(onStarted).toHaveBeenCalledTimes(1);
    await next("New note");
    await next("Folders");
    fireEvent.click(within(card()).getByRole("button", { name: "Back" }));
    await findCard("New note");
    fireEvent.click(within(card()).getByRole("button", { name: "Back" }));
    await findCard("Sidebar sections");
    setNarrow(true);
    await waitFor(() => expect(hole()).toEqual(padded(RECTS.drawerButton)));
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onFinished).not.toHaveBeenCalled();
  });

  it("finish results: Keep sample note and Delete -> completed, close -> closed, all with started=true", async () => {
    for (const [name, reason] of [
      ["Keep sample note", "completed"],
      ["Delete sample note", "completed"],
      ["Close", "closed"],
    ] as const) {
      const { onStarted, onFinished, unmount } = await startTour();
      if (name === "Close") await findCard("Sidebar sections");
      else await goToLast();
      fireEvent.click(within(card()).getByRole("button", { name }));
      await waitFor(() => expect(onFinished, name).toHaveBeenCalledTimes(1));
      expect(onFinished, name).toHaveBeenCalledWith({ started: true, reason });
      expect(onStarted, name).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("location leaves the sample note after reaching a stop -> started=true, reason=left", async () => {
    const { onFinished } = await startTour();
    await findCard("Sidebar sections");
    act(() => void routerNavigate!("/login"));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(onFinished).toHaveBeenCalledWith({ started: true, reason: "left" });
  });

  it("StrictMode (dev mounting runs effects twice): onStarted is still called once", async () => {
    const { onStarted } = await startTour({ strict: true });
    await findCard("Sidebar sections");
    await new Promise((r) => setTimeout(r, 50));
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("StrictMode (dev mounting runs effects twice): the sample note is prepared once and AI actions are read once", async () => {
    const { prepareSample } = await startTour({ strict: true });
    await findCard("Sidebar sections");
    expect(prepareSample).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.url === "/api/ai/actions")).toHaveLength(1);
    expect(document.querySelectorAll("[data-tour-overlay]")).toHaveLength(1);
  });

  it("search box has text: the tab list, folder and search stops are dropped, starting from New note for 6 stops", async () => {
    await startTour({
      before: () => {
        fireEvent.change(screen.getByRole("textbox", { name: "Search notes" }), { target: { value: "ab" } });
      },
    });
    await findCard("New note");
    expect(progress()).toBe("1 / 6");
  });
});

describe("the stop count uses the AI actions read from the server at start", () => {
  const aiOnly = (ctxAi: (n: number) => void) =>
    [
      fakeEntry("ai", "tabs", {
        precondition: (ctx) => {
          ctxAi(ctx.aiActions.length);
          return ctx.aiActions.length > 0;
        },
      }),
      fakeEntry("last", "userMenu"),
    ] satisfies TourStopEntry[];

  it("cache is empty and the API returns non-empty -> the AI stop is in the sequence", async () => {
    queryClient.setQueryData(["ai-actions"], []);
    aiActions = [AI_ACTION];
    const seen: number[] = [];
    await startTour({ props: { stops: aiOnly((n) => seen.push(n)) } });
    await findCard("fake.ai");
    expect(progress()).toBe("1 / 2");
    expect(seen).toEqual([1]);
  });

  it("read once per round: issued before the sample note is ready, and what prepareSample receives is the same read used to compute the stops", async () => {
    aiActions = [AI_ACTION];
    const seen: number[] = [];
    const order: string[] = [];
    let received: AiActionDto[] | null = null;
    const prepareSample = vi.fn(async (signal: AbortSignal, ai: Promise<AiActionDto[]>) => {
      const note = await fakePrepareSample(signal);
      order.push(`sample ready, ai fetched=${calls.some((c) => c.url === "/api/ai/actions")}`);
      received = await ai;
      // A later read would be empty: if the stops did their own read, the AI stop would disappear.
      aiActions = [];
      return note;
    });
    await startTour({ props: { stops: aiOnly((n) => seen.push(n)), prepareSample } });
    await findCard("fake.ai");
    expect(order).toEqual(["sample ready, ai fetched=true"]);
    expect(received).toEqual([AI_ACTION]);
    expect(seen).toEqual([1]);
    expect(calls.filter((c) => c.url === "/api/ai/actions")).toHaveLength(1);
  });

  it("API failure -> no AI stop", async () => {
    aiActions = "error";
    await startTour({ props: { stops: aiOnly(() => {}) } });
    await findCard("fake.last");
    expect(progress()).toBe("1 / 1");
  });
});

describe("location leaves the sample note during the tour -> finish", () => {
  it("redirected to /login: overlay disappears, leave cleanup runs once, no navigation back to the original page, onFinished", async () => {
    const first = fakeEntry("one", "tabs");
    const { onFinished } = await startTour({ props: { stops: [first, fakeEntry("two", "userMenu")] } });
    await findCard("fake.one");
    act(() => void routerNavigate!("/login"));
    await waitFor(() => expect(overlay()).toBeNull());
    expect(first.leave).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(currentPath).toBe("/login");
  });

  it("Back to the page from before opening: the tour finishes without a duplicate navigation", async () => {
    const { onFinished } = await startTour();
    await findCard("Sidebar sections");
    act(() => void routerNavigate!(-1));
    await waitFor(() => expect(overlay()).toBeNull());
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(currentPath).toBe(OTHER_PATH);
  });

  it("the same note with only a changed search (e.g. ?present in presentation mode) does not count as leaving", async () => {
    await startTour();
    await findCard("Sidebar sections");
    act(() => void routerNavigate!(`${SAMPLE_PATH}?x=1`));
    await new Promise((r) => setTimeout(r, 100));
    expect(overlay()).not.toBeNull();
  });
});

describe("keyboard", () => {
  it("Esc: finishes, returns to the original page, does not delete the sample note", async () => {
    const { onFinished } = await startTour();
    await findCard("Sidebar sections");
    await next("New note");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(overlay()).toBeNull();
    expect(currentPath).toBe(OTHER_PATH);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("returning to the original page replaces history: Back after finishing does not go to the sample note", async () => {
    const { onFinished } = await startTour();
    await findCard("Sidebar sections");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(currentPath).toBe(OTHER_PATH);
    act(() => void routerNavigate!(-1));
    await new Promise((r) => setTimeout(r, 50));
    expect(currentPath).toBe(OTHER_PATH);
  });

  it("close and stop 1's Skip behave the same: finish, return to the original page, no deletion", async () => {
    for (const name of ["Close", "Skip feature tour"]) {
      const { onFinished, unmount } = await startTour();
      await findCard("Sidebar sections");
      fireEvent.click(within(card()).getByRole("button", { name }));
      await waitFor(() => expect(onFinished, name).toHaveBeenCalledTimes(1));
      expect(currentPath, name).toBe(OTHER_PATH);
      unmount();
    }
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("Ctrl+K does not focus the search box during the tour (it does without a tour)", async () => {
    await startTour();
    await findCard("Sidebar sections");
    const search = screen.getByRole("textbox", { name: "Search notes" });
    fireEvent.keyDown(document.activeElement!, { key: "k", ctrlKey: true });
    expect(document.activeElement).not.toBe(search);
    expect(document.activeElement).toBe(within(card()).getByRole("button", { name: "Next" }));

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(overlay()).toBeNull());
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(search);
  });

  it("focus is on Next; Tab cycles within the card", async () => {
    await startTour();
    await findCard("Sidebar sections");
    const c = within(card());
    expect(document.activeElement).toBe(c.getByRole("button", { name: "Next" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(c.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(c.getByRole("button", { name: "Skip feature tour" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(c.getByRole("button", { name: "Close" }));
  });
});

describe("live stop keyboard and focus", () => {
  /** The first stop is a live stop (`live` returns true), the second is a regular stop. */
  const liveThenStatic = (live: StopDef["live"] = () => true) => [
    fakeEntry("live", "tabs", { live }),
    fakeEntry("plain", "userMenu"),
  ];
  const press = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    document.body.dispatchEvent(event);
    return event;
  };

  it("live stop: the card does not take focus and announces the stop-change keys; the right arrow goes to the next stop and other keys are blocked", async () => {
    const stops = liveThenStatic();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    await startTour({ props: { stops } });
    await findCard("fake.live");
    expect(card()).toHaveTextContent("← → to change stops, Esc to end");
    expect(card().contains(document.activeElement)).toBe(false);
    expect(press({ key: "a" }).defaultPrevented).toBe(true);
    expect(progress()).toBe("1 / 2");

    press({ key: "ArrowRight" });
    await findCard("fake.plain");
    expect(progress()).toBe("2 / 2");
    expect(card()).not.toHaveTextContent("← → to change stops");
    expect(card().contains(document.activeElement)).toBe(true);

    // A regular stop does not intercept keys; going back uses the card's Back button.
    fireEvent.click(within(card()).getByRole("button", { name: "Back" }));
    await findCard("fake.live");
    expect(progress()).toBe("1 / 2");
    outside.remove();
  });

  it("live stop: Enter also goes to the next stop; Esc ends the tour", async () => {
    const { onFinished } = await startTour({ props: { stops: liveThenStatic() } });
    await findCard("fake.live");
    press({ key: "Enter" });
    await findCard("fake.plain");
    fireEvent.click(within(card()).getByRole("button", { name: "Back" }));
    await findCard("fake.live");
    press({ key: "ArrowRight" });
    await findCard("fake.plain");
    fireEvent.click(within(card()).getByRole("button", { name: "Back" }));
    await findCard("fake.live");
    press({ key: "Escape" });
    await waitFor(() => expect(overlay()).toBeNull());
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith({ started: true, reason: "closed" }));
  });

  it("keys pass through after leaving the live stop", async () => {
    await startTour({ props: { stops: liveThenStatic() } });
    await findCard("fake.live");
    press({ key: "ArrowRight" });
    await findCard("fake.plain");
    expect(press({ key: "a" }).defaultPrevented).toBe(false);
  });

  it("this round is not live (live returns false): keys are not intercepted, focus enters the card, no stop-change hint", async () => {
    await startTour({ props: { stops: liveThenStatic(() => false) } });
    await findCard("fake.live");
    expect(card()).not.toHaveTextContent("← → to change stops");
    expect(card().contains(document.activeElement)).toBe(true);
    expect(press({ key: "a" }).defaultPrevented).toBe(false);
    expect(press({ key: "ArrowRight" }).defaultPrevented).toBe(false);
    expect(progress()).toBe("1 / 2");
  });

  it("the context handed to the stops carries the sample note's id; with no registered editor for the sample note liveStops is false", async () => {
    const seen: StopContext[] = [];
    const stops = [fakeEntry("live", "tabs", { live: (ctx) => (seen.push(ctx), ctx.liveStops) })];
    await startTour({ props: { stops } });
    await findCard("fake.live");
    expect(seen.length).toBeGreaterThan(0);
    for (const ctx of seen) {
      expect(ctx.sampleNoteId).toBe(SAMPLE.id);
      expect(ctx.liveStops).toBe(false);
    }
  });

  it("the sample note's editor is editable and ends with an empty paragraph: liveStops is true (the live stop's live returns true)", async () => {
    const editor = {
      isEditable: true,
      document: [{ type: "paragraph", children: [], content: [] }],
    } as unknown as TourEditor;
    const off = registerEditor(SAMPLE.id, editor);
    try {
      const seen: StopContext[] = [];
      const stops = [fakeEntry("live", "tabs", { live: (ctx) => (seen.push(ctx), ctx.liveStops) })];
      await startTour({ props: { stops } });
      await findCard("fake.live");
      expect(seen.length).toBeGreaterThan(0);
      for (const ctx of seen) expect(ctx.liveStops).toBe(true);
      expect(card()).toHaveTextContent("← → to change stops, Esc to end");
      expect(press({ key: "a" }).defaultPrevented).toBe(true);
    } finally {
      off();
    }
  });

  it("switching to a live stop while its target is not drawn yet: keys are already intercepted (repeated Enter cannot reach the editor), and the stop runs normally once the target appears", async () => {
    hiddenTargets = new Set(["versions"]);
    const stops = [fakeEntry("plain", "userMenu"), fakeEntry("live", "versions", { live: () => true })];
    const editorSide = vi.fn();
    document.body.addEventListener("keydown", editorSide);
    try {
      await startTour({ props: { stops } });
      await findCard("fake.plain");
      expect(press({ key: "a" }).defaultPrevented).toBe(false);
      editorSide.mockClear();
      fireEvent.click(within(card()).getByRole("button", { name: "Next" }));
      // Switching stops waits for the target: the screen still shows the previous stop, but the next stop's prepare has already run.
      await waitFor(() => expect(press({ key: "Enter" }).defaultPrevented).toBe(true));
      expect(press({ key: "Enter" }).defaultPrevented).toBe(true);
      expect(editorSide).not.toHaveBeenCalled();
      expect(progress()).toBe("1 / 2");
      // Key interception follows the stop being prepared, while the card's look follows only the stop on screen: the previous stop is regular, so there is no stop-change hint and focus stays in the card.
      expect(card()).not.toHaveTextContent("← → to change stops");
      expect(card().contains(document.activeElement)).toBe(true);
      hiddenTargets = new Set();
      await findCard("fake.live");
      expect(progress()).toBe("2 / 2");
    } finally {
      document.body.removeEventListener("keydown", editorSide);
    }
  });

  it("keys pass through after the tour unmounts", async () => {
    const { unmountRunner } = await startTour({ props: { stops: liveThenStatic() } });
    await findCard("fake.live");
    expect(press({ key: "a" }).defaultPrevented).toBe(true);
    unmountRunner();
    await waitFor(() => expect(overlay()).toBeNull());
    expect(press({ key: "a" }).defaultPrevented).toBe(false);
  });
});

describe("stops are skipped when the target never appears", () => {
  it("the version bubble and the `[[` link stay at size 0 -> both stops are skipped and the tour continues to the next one (stop numbers keep the original order)", async () => {
    hiddenTargets = new Set(["versions", "wikilink"]);
    await startTour();
    await findCard("Sidebar sections");
    for (const title of FULL_TITLES.slice(1, 5)) await next(title);
    fireEvent.click(within(card()).getByRole("button", { name: "Next" }));
    await screen.findByRole("dialog", { name: "Insert blocks with /" }, { timeout: TARGET_TIMEOUT_MS * 2 + 2000 });
    expect(progress()).toBe("8 / 9");
  }, TARGET_TIMEOUT_MS * 2 + 5000);
});

describe("narrow window: the drawer is open at start", () => {
  it("closes the drawer and waits for it to leave the DOM before preparing the sample note; stop 1 points at the hamburger button", async () => {
    stubViewport(true);
    const drawerAtPrepare: boolean[] = [];
    const prepareSample = vi.fn(async (signal: AbortSignal) => {
      drawerAtPrepare.push(document.querySelector("[data-sidebar-drawer]") !== null);
      return fakePrepareSample(signal);
    });
    await startTour({
      initial: "/",
      props: { prepareSample },
      before: async () => {
        fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
        await screen.findByRole("dialog", { name: "Navigation" });
      },
    });
    await findCard("Sidebar sections");
    expect(drawerAtPrepare).toEqual([false]);
    expect(document.querySelector("[data-sidebar-drawer]")).toBeNull();
    expect(hole()).toEqual(padded(RECTS.drawerButton));
  });
});

describe("the wide/narrow breakpoint changes", () => {
  it("narrowing during the tour: the current stop's target becomes the hamburger button and the body switches to the narrow-window text", async () => {
    await startTour();
    await findCard("Sidebar sections");
    expect(hole()).toEqual(padded(RECTS.tabs));
    expect(card()).toHaveAccessibleDescription(i18n.t("tourGuide.stops.tabs.body"));
    setNarrow(true);
    await waitFor(() => expect(hole()).toEqual(padded(RECTS.drawerButton)));
    expect(card()).toHaveAccessibleDescription(i18n.t("tourGuide.stops.tabs.narrowBody"));
  });

  it("a stop with only narrow-window text and an unchanged target: the body follows when crossing the breakpoint and the hole does not move", async () => {
    const entry = fakeEntry("one", "tabs", { narrowBodyKey: "fake.one.narrowBody" });
    await startTour({ props: { stops: [entry, fakeEntry("two", "userMenu")] } });
    await findCard("fake.one");
    expect(card()).toHaveAccessibleDescription("fake.one.body");
    setNarrow(true);
    await waitFor(() => expect(card()).toHaveAccessibleDescription("fake.one.narrowBody"));
    expect(hole()).toEqual(padded(RECTS.tabs));
    setNarrow(false);
    await waitFor(() => expect(card()).toHaveAccessibleDescription("fake.one.body"));
  });
});

describe("sidebar tab restored after finishing", () => {
  it("wide window: on Groups before the tour, switched to My notes during it, back on Groups after finishing", async () => {
    localStorage.setItem("sidebar.tab", "workspace");
    const { onFinished } = await startTour();
    await findCard("Sidebar sections");
    await next("New note");
    expect(getShellControls()!.getTab()).toBe("myNotes");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(getShellControls()!.getTab()).toBe("workspace");
    expect(localStorage.getItem("sidebar.tab")).toBe("workspace");
  });

  it("a narrow window does not call showTab (switching tabs there opens the drawer): after narrowing during the tour and finishing, the tab stays and the drawer does not open", async () => {
    localStorage.setItem("sidebar.tab", "workspace");
    const { onFinished } = await startTour();
    await findCard("Sidebar sections");
    await next("New note");
    setNarrow(true);
    const showTab = vi.spyOn(getShellControls()!, "showTab");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(showTab).not.toHaveBeenCalled();
    expect(getShellControls()!.getTab()).toBe("myNotes");
    expect(document.querySelector("[data-sidebar-drawer]")).toBeNull();
  });
});

describe("focus after finishing", () => {
  it("opened from the home page: the sidebar that held the trigger button is unmounted -> focus lands on the newly mounted account row", async () => {
    const { onFinished, startedWith } = await startTour({ initial: "/" });
    await goToLast();
    fireEvent.click(within(card()).getByRole("button", { name: "Keep sample note" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(currentPath).toBe("/");
    expect(startedWith.trigger).not.toBeNull();
    expect(startedWith.trigger!.isConnected).toBe(false);
    const account = findUserMenuTrigger();
    expect(account).not.toBe(startedWith.trigger);
    expect(document.activeElement).toBe(account);
  });

  it("narrow window: focus is on the hamburger button", async () => {
    stubViewport(true);
    const { onFinished } = await startTour();
    await findCard("Sidebar sections");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(currentPath).toBe(OTHER_PATH);
    expect(document.activeElement).toBe(within(document.querySelector(`[data-note-id="${OTHER.id}"]`)!).getByRole("button", { name: "Open sidebar" }));
  });

  it("the lookup function returns null -> the title box of the page returned to", async () => {
    const { onFinished } = await startTour({ props: { returnFocus: () => null } });
    await findCard("Sidebar sections");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Note title" }));
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue(OTHER.title);
  });
});

describe("Delete", () => {
  it("returns to the original page first, then moves the note to the trash; a success toast with undo appears; focus stays on the account row", async () => {
    const { onFinished } = await startTour();
    await goToLast();
    fireEvent.click(within(card()).getByRole("button", { name: "Delete sample note" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toEqual([{ method: "DELETE", url: `/api/notes/${SAMPLE.id}`, at: OTHER_PATH }]);
    expect(await screen.findByText(i18n.t("trash.moved"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("trash.undo") })).toBeInTheDocument();
    expect(currentPath).toBe(OTHER_PATH);
    expect(document.activeElement).toBe(findUserMenuTrigger());
  });

  it("moving to the trash fails -> one error toast and no trash toast; the tour still finishes", async () => {
    deleteStatus = 500;
    const { onFinished } = await startTour();
    await goToLast();
    fireEvent.click(within(card()).getByRole("button", { name: "Delete sample note" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(await screen.findAllByText(i18n.t("errors.internal"))).toHaveLength(1);
    expect(screen.queryByText(i18n.t("trash.moved"))).not.toBeInTheDocument();
    expect(overlay()).toBeNull();
    expect(currentPath).toBe(OTHER_PATH);
  });
});

describe("unmount", () => {
  it("unmounting during the tour: the visible stop cleans up once, the overlay disappears, onFinished is not called and there is no navigation", async () => {
    const first = fakeEntry("one", "tabs");
    const { onFinished, unmountRunner } = await startTour({ props: { stops: [first, fakeEntry("two", "userMenu")] } });
    await findCard("fake.one");
    unmountRunner();
    expect(first.leave).toHaveBeenCalledTimes(1);
    expect(overlay()).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(onFinished).not.toHaveBeenCalled();
    expect(currentPath).toBe(SAMPLE_PATH);
  });
});

describe("phone (narrower than 640)", () => {
  beforeEach(() => stubTier("phone"));

  /** Phone stops: title, hole, and where each should be (the list is `/`, the rest are on the sample note). */
  const PHONE_STOPS: [string, { x: number; y: number; width: number; height: number }, string][] = [
    ["Lists of notes", padded(RECTS.tabs), "/"],
    ["New note", padded(RECTS.phoneNewNote), "/"],
    ["Folders", padded(RECTS.newFolder), "/"],
    ["Search", padded(RECTS.phoneSearch), "/"],
    // union of the share button and the kebab menu
    ["Share and more", padded([900, 10, 100, 30]), SAMPLE_PATH],
    ["Version history", padded(RECTS.noteMenu), SAMPLE_PATH],
    ["Link to another note", padded(RECTS.wikilink), SAMPLE_PATH],
    ["Insert blocks with /", padded(RECTS.flowchart), SAMPLE_PATH],
    ["Forgot how something works?", padded(RECTS.userMenu), "/"],
  ];

  const avatar = () => within(document.querySelector<HTMLElement>("[data-phone-top-bar]")!).getByRole("button", { name: USER.displayName });

  it("stops on the list point at real things on the list, stops on the note go back to the sample note, and the last stop returns to the list and points at the avatar; the AI stop is skipped immediately and takes no number; finishing leaves you on the list with focus on the avatar", async () => {
    aiActions = [AI_ACTION];
    const { onFinished } = await startTour({ initial: "/" });
    for (const [i, [title, rect, path]] of PHONE_STOPS.entries()) {
      // If the AI stop waited TARGET_TIMEOUT_MS before skipping, findCard's default wait (1 s) would time out first.
      if (i === 0) await findCard(title);
      else await next(title);
      expect(progress(), title).toBe(`${i + 1} / ${PHONE_STOPS.length}`);
      expect(currentPath, title).toBe(path);
      await waitFor(() => expect(hole(), title).toEqual(rect));
      expect(card(), title).not.toHaveAccessibleDescription(/\{\{|Ctrl|sidebar|‹/);
    }
    expect(card()).toHaveAccessibleDescription(i18n.t("tourGuide.stops.userMenu.phoneBody"));
    fireEvent.click(within(card()).getByRole("button", { name: "Keep sample note" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith({ started: true, reason: "completed" }));
    expect(currentPath).toBe("/");
    expect(document.activeElement).toBe(avatar());
  });

  it("starting from a note: first returns to the list for the list stops; Esc on a note stop midway -> back to the list with focus on the avatar (not the title box) and the tab restored to its pre-start value", async () => {
    localStorage.setItem("sidebar.tab", "workspace");
    const { onFinished } = await startTour();
    await findCard("Lists of notes");
    expect(currentPath).toBe("/");
    for (const title of ["New note", "Folders", "Search", "Share and more"]) await next(title);
    expect(currentPath).toBe(SAMPLE_PATH);
    expect(getShellControls()!.getTab()).toBe("myNotes");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(currentPath).toBe("/");
    expect(document.activeElement).toBe(avatar());
    expect(getShellControls()!.getTab()).toBe("workspace");
  });

  it("going back: Back on the first note stop returns to the search stop on the list, then Next returns to the sample note", async () => {
    await startTour({ initial: "/" });
    await findCard("Lists of notes");
    for (const title of ["New note", "Folders", "Search", "Share and more"]) await next(title);
    fireEvent.click(within(card()).getByRole("button", { name: "Back" }));
    await findCard("Search");
    expect(currentPath).toBe("/");
    await waitFor(() => expect(hole()).toEqual(padded(RECTS.phoneSearch)));
    await next("Share and more");
    expect(currentPath).toBe(SAMPLE_PATH);
    await waitFor(() => expect(hole()).toEqual(padded([900, 10, 100, 30])));
  });

  it("during a screen change the card is hidden with no hole, and shown once the screen appears", async () => {
    await startTour({ initial: "/" });
    await findCard("Lists of notes");
    for (const title of ["New note", "Folders", "Search"]) await next(title);
    const seen: { hidden: boolean; hole: boolean }[] = [];
    const observer = new MutationObserver(() => {
      const el = document.querySelector("[data-tour-card]");
      if (el !== null) seen.push({ hidden: el.classList.contains("invisible"), hole: document.querySelector("[data-tour-hole]") !== null });
    });
    observer.observe(document.body, { subtree: true, attributes: true, childList: true });
    await next("Share and more");
    observer.disconnect();
    expect(seen.some((s) => s.hidden && !s.hole)).toBe(true);
    expect(card()).not.toHaveClass("invisible");
  });

  it("location moves to another note while on a list stop -> finish (left)", async () => {
    const { onFinished } = await startTour({ initial: "/" });
    await findCard("Lists of notes");
    act(() => void routerNavigate!(OTHER_PATH));
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith({ started: true, reason: "left" }));
  });
});

describe("phone: screen changes and leaving", () => {
  beforeEach(() => stubTier("phone"));
  afterEach(() => {
    noteTitleShown = true;
  });

  const avatar = () => within(document.querySelector<HTMLElement>("[data-phone-top-bar]")!).getByRole("button", { name: USER.displayName });

  it("Back on a list stop (the list at the same path) -> finish (left)", async () => {
    const { onFinished } = await startTour({ initial: "/" });
    await findCard("Lists of notes");
    expect(currentPath).toBe("/");
    act(() => void routerNavigate!(-1));
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith({ started: true, reason: "left" }));
    expect(overlay()).toBeNull();
  });

  it("screen changes replace history: after switching between the list and the sample note several times, Back returns to the page from before the tour started", async () => {
    const { onFinished } = await startTour();
    await findCard("Lists of notes");
    for (const title of ["New note", "Folders", "Search", "Share and more"]) await next(title);
    fireEvent.click(within(card()).getByRole("button", { name: "Back" }));
    await findCard("Search");
    await next("Share and more");
    expect(currentPath).toBe(SAMPLE_PATH);
    act(() => void routerNavigate!(-1));
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith({ started: true, reason: "left" }));
    expect(currentPath).toBe(OTHER_PATH);
  });

  it("scrolls back to the top when returning to the list", async () => {
    const scrollY = vi.spyOn(window, "scrollY", "get").mockReturnValue(300);
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    await startTour({ initial: "/" });
    await findCard("Lists of notes");
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    scrollY.mockRestore();
  });

  it("the card always avoids the part covered by the on-screen keyboard (the visual viewport gets shorter)", async () => {
    vi.stubGlobal("visualViewport", { height: window.innerHeight - 300, offsetTop: 0, scale: 1, addEventListener: () => {}, removeEventListener: () => {} });
    await startTour({ initial: "/" });
    await findCard("Lists of notes");
    await waitFor(() => expect(Number.parseFloat(card().style.maxHeight)).toBeLessThanOrEqual(window.innerHeight - 300 - 16));
  });

  it(`the sample note's screen does not appear within ${SCREEN_TIMEOUT_MS} ms (e.g. it was trashed elsewhere) -> finish (left) and the overlay is removed`, async () => {
    const { onFinished } = await startTour({ initial: "/" });
    await findCard("Lists of notes");
    for (const title of ["New note", "Folders", "Search"]) await next(title);
    noteTitleShown = false;
    fireEvent.click(within(card()).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(currentPath).toBe(SAMPLE_PATH));
    expect(card()).toHaveClass("invisible");
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith({ started: true, reason: "left" }), { timeout: SCREEN_TIMEOUT_MS + 3000 });
    expect(overlay()).toBeNull();
  }, SCREEN_TIMEOUT_MS * 3);

  it("Esc during a screen change (from the list to the sample note) -> back to the list with focus on the avatar", async () => {
    const { onFinished } = await startTour({ initial: "/" });
    await findCard("Lists of notes");
    for (const title of ["New note", "Folders", "Search"]) await next(title);
    noteTitleShown = false;
    fireEvent.click(within(card()).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(card()).toHaveClass("invisible"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith({ started: true, reason: "closed" }));
    expect(currentPath).toBe("/");
    expect(document.activeElement).toBe(avatar());
  });

  it("Esc before the screen-change navigation has taken effect (the list is still on screen): it is still replaced with the list and does not end up on the sample note", async () => {
    const history = new DeferredHistory("/");
    const { onFinished } = await startTour({ initial: "/", history });
    await findCard("Lists of notes");
    for (const title of ["New note", "Folders", "Search"]) await next(title);
    history.manual = true;
    fireEvent.click(within(card()).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(history.calls.at(-1)).toEqual({ action: NavigationType.Replace, pathname: SAMPLE_PATH }));
    expect(currentPath).toBe("/");
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(history.calls.at(-1)).toEqual({ action: NavigationType.Replace, pathname: "/" }));
    act(() => history.commit());
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith({ started: true, reason: "closed" }));
    expect(currentPath).toBe("/");
  });

  it("leaving to another note: not pulled back to the list, but the sidebar tab is restored to its pre-start value", async () => {
    localStorage.setItem("sidebar.tab", "workspace");
    const { onFinished } = await startTour({ initial: "/" });
    await findCard("Lists of notes");
    await next("New note");
    expect(getShellControls()!.getTab()).toBe("myNotes");
    act(() => void routerNavigate!(OTHER_PATH));
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith({ started: true, reason: "left" }));
    expect(currentPath).toBe(OTHER_PATH);
    expect(getShellControls()!.getTab()).toBe("workspace");
  });
});

describe("crossing 640 and 1280 during the tour", () => {
  it("stop 1: sidebar button <-> the list screen's tab list (switching to the list) <-> sidebar button (back on the sample note) <-> the sidebar's tab list, with the title and body following", async () => {
    stubTier("overlay");
    await startTour();
    await findCard("Sidebar sections");
    expect(hole()).toEqual(padded(RECTS.drawerButton));
    expect(card()).toHaveAccessibleDescription(i18n.t("tourGuide.stops.tabs.narrowBody"));

    setTier("phone");
    await findCard("Lists of notes");
    await waitFor(() => expect(currentPath).toBe("/"));
    await waitFor(() => expect(hole()).toEqual(padded(RECTS.tabs)));
    expect(card()).toHaveAccessibleDescription(i18n.t("tourGuide.stops.tabs.phoneBody"));

    setTier("overlay");
    await findCard("Sidebar sections");
    await waitFor(() => expect(currentPath).toBe(SAMPLE_PATH));
    await waitFor(() => expect(hole()).toEqual(padded(RECTS.drawerButton)));
    expect(card()).toHaveAccessibleDescription(i18n.t("tourGuide.stops.tabs.narrowBody"));

    setTier("docked");
    await waitFor(() => expect(hole()).toEqual(padded(RECTS.tabs)));
    expect(card()).toHaveAccessibleDescription(i18n.t("tourGuide.stops.tabs.body"));
  });

  it("version stop: wide and floating-sidebar layouts point at the bubble, phone points at the kebab menu", async () => {
    stubTier("docked");
    await startTour();
    await findCard("Sidebar sections");
    for (const title of ["New note", "Folders", "Search", "Share and more", "Version history"]) await next(title);
    await waitFor(() => expect(hole()).toEqual(padded(RECTS.versions)));
    setTier("overlay");
    await new Promise((r) => setTimeout(r, 50));
    expect(card()).toHaveAccessibleDescription(/bottom-right corner/);
    expect(hole()).toEqual(padded(RECTS.versions));
    setTier("phone");
    await waitFor(() => expect(hole()).toEqual(padded(RECTS.noteMenu)));
    expect(card()).toHaveAccessibleDescription(i18n.t("tourGuide.stops.versions.phoneBody"));
  });

  it("'n / N' follows the layout's count: with an AI stop the phone counts one fewer", async () => {
    aiActions = [AI_ACTION];
    stubTier("overlay");
    await startTour();
    await findCard("Sidebar sections");
    for (const title of ["New note", "Folders", "Search", "Share and more", "Version history", "Link to another note"]) await next(title);
    expect(progress()).toBe("7 / 10");
    setTier("phone");
    await waitFor(() => expect(progress()).toBe("7 / 9"));
    setTier("overlay");
    await waitFor(() => expect(progress()).toBe("7 / 10"));
  });

  it("switching to a phone while on a stop the phone lacks: the card stays on that stop (no hole) and 'n / N' counts it; going back works as usual", async () => {
    const skipped = fakeEntry("two", "share", { skipOnPhone: true });
    await startTour({ props: { stops: [fakeEntry("one", "noteMenu"), skipped, fakeEntry("three", "userMenu")] } });
    await findCard("fake.one");
    await next("fake.two");
    expect(progress()).toBe("2 / 3");
    setTier("phone");
    await waitFor(() => expect(hole()).toBeNull());
    expect(progress()).toBe("2 / 3");
    fireEvent.click(within(card()).getByRole("button", { name: "Back" }));
    await findCard("fake.one");
    expect(progress()).toBe("1 / 2");
  });

  it("skipping a stop the phone lacks while going back is immediate too", async () => {
    stubTier("phone");
    const skipped = fakeEntry("two", "share", { skipOnPhone: true });
    await startTour({ props: { stops: [fakeEntry("one", "noteMenu"), skipped, fakeEntry("three", "userMenu")] } });
    await findCard("fake.one");
    expect(progress()).toBe("1 / 2");
    await next("fake.three");
    expect(progress()).toBe("2 / 2");
    fireEvent.click(within(card()).getByRole("button", { name: "Back" }));
    await findCard("fake.one");
    expect(skipped.leave).toHaveBeenCalledTimes(2);
  });
});
