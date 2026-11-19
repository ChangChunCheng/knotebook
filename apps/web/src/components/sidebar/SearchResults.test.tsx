import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { canonicalNotePath, type GroupDto, type NoteDto, type NoteSearchHitDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider, useActiveNote } from "@/lib/active-note";
import { adminRole, EDITOR_PERMS, groupDto, OWNER_PERMS } from "@/test/fixtures";
import { SearchResults, highlightTitle } from "./SearchResults";
import { FOLDER_LIST_EMPTY, folderDto } from "@/test/folder-fixtures";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

function fakeResponse(ok: boolean, status: number, body?: unknown): Response {
  return {
    ok,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as unknown as Response;
}

function note(id: string, title: string, over: Partial<NoteDto> = {}): NoteDto {
  return {
    id,
    title,
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: `slug-${id}`,
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "owner-one",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
    ...over,
  };
}

const GROUP_A: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" }, adminRole());

const ALPHA_PLAN = note("n1", "Alpha Plan");
const ALPHA_GROUP = note("n2", "Alpha Group", {
  ownerId: null,
  ownerHandle: null,
  role: "editor",
  groupId: GROUP_A.id,
  group: { id: GROUP_A.id, name: GROUP_A.name },
  permissions: EDITOR_PERMS,
});
const ALPHA_SHARED = note("n3", "alpha shared", {
  ownerId: "u9",
  role: "editor",
  ownerHandle: "owner-nine",
  permissions: EDITOR_PERMS,
});
const BETA = note("n4", "Beta");
const FIXTURE = [ALPHA_PLAN, ALPHA_GROUP, ALPHA_SHARED, BETA];

/** #93: the `/api/search` response (empty by default). A test can swap in its own handler (returning a Response or a Promise). */
const EMPTY_SEARCH = () => fakeResponse(true, 200, { hits: [], nextCursor: null });
let searchHandler: (url: string) => Response | Promise<Response> = EMPTY_SEARCH;
let searchUrls: string[] = [];

function stubFetch(notes: NoteDto[] | "pending" | "error", groups: GroupDto[] = [GROUP_A]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/api/search?")) {
        searchUrls.push(url);
        return Promise.resolve(searchHandler(url));
      }
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") {
        if (notes === "pending") return new Promise(() => {});
        if (notes === "error") return Promise.resolve(fakeResponse(false, 500, { error: "internal" }));
        return Promise.resolve(fakeResponse(true, 200, notes));
      }
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse(true, 200, groups));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function SetActive({ id }: { id: string }) {
  const { setActiveNoteId } = useActiveNote();
  useEffect(() => {
    setActiveNoteId(id);
  }, [id, setActiveNoteId]);
  return null;
}

function renderResults(query: string, activeId?: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ActiveNoteProvider>
          {activeId !== undefined && <SetActive id={activeId} />}
          <SearchResults query={query} />
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Gets a result row link by `^title` (its accessible name is "title location"). */
function rowLink(title: string): HTMLElement {
  return screen.getByRole("link", { name: new RegExp("^" + escapeRe(title)) });
}

describe("SearchResults", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("flat results, server order, location line and result count", async () => {
    stubFetch(FIXTURE);
    renderResults("alpha");
    await screen.findByRole("link", { name: /^Alpha Plan/ });
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items.map((li) => li.querySelector("div:nth-child(1)")?.textContent)).toEqual([
      "Alpha Plan",
      "Alpha Group",
      "alpha shared",
    ]);
    expect(items.map((li) => li.querySelector("div:nth-child(2)")?.textContent)).toEqual([
      "My notes",
      "Groups › Workshop A",
      "Shared with me · Editor",
    ]);
    expect(screen.getByRole("status")).toHaveTextContent("3 title matches");
  });

  it("with only one result it says 1 result", async () => {
    stubFetch(FIXTURE);
    renderResults("beta");
    await screen.findByRole("link", { name: /^Beta/ });
    expect(screen.getByRole("status").textContent).toMatch(/\b1 title match$/);
  });

  it("result count in zh-TW", async () => {
    await i18n.changeLanguage("zh-TW");
    stubFetch(FIXTURE);
    renderResults("alpha");
    await screen.findByRole("link", { name: /^Alpha Plan/ });
    expect(screen.getByRole("status")).toHaveTextContent("標題符合 · 3 篇");
  });

  it("highlight marks only the first hit, keeps the original case, and the title text is complete", async () => {
    stubFetch([note("s1", "Has A Slug")]);
    renderResults("a sl");
    const link = await screen.findByRole("link", { name: /^Has A Slug/ });
    const marks = link.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent("A Sl");
    expect(marks[0]).toHaveClass("bg-search-highlight");
    expect(link.querySelector("div")?.textContent).toBe("Has A Slug");
  });

  it("a title whose length changes after toLowerCase is still listed, with no mark and the full title", async () => {
    stubFetch([note("s1", "İstanbul notes")]);
    renderResults("notes");
    const link = await screen.findByRole("link", { name: /^İstanbul notes/ });
    expect(link.querySelector("mark")).toBeNull();
    expect(link.querySelector("div")?.textContent).toBe("İstanbul notes");
  });

  it("the query string is matched literally (parentheses do not throw, a dot is not a wildcard)", async () => {
    stubFetch([note("s1", "x (y)"), note("s2", "axb")]);
    const first = renderResults("(");
    await screen.findByRole("link", { name: /^x \(y\)/ });
    expect(screen.queryByRole("link", { name: /^axb/ })).not.toBeInTheDocument();
    first.unmount();

    renderResults("a.b");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("0 title matches"));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(await screen.findByText("No notes match your search.")).toBeInTheDocument();
  });

  it("no hit: 0 results, the hint is visible, no listitem", async () => {
    stubFetch(FIXTURE);
    renderResults("zzz");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("0 title matches"));
    expect(await screen.findByText("No notes match your search.")).toBeVisible();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("no kebab, href is canonicalNotePath, the accessible name includes the location, aria-current and optimistic active", async () => {
    stubFetch(FIXTURE);
    renderResults("alpha", ALPHA_PLAN.id);
    await screen.findByRole("link", { name: /^Alpha Plan/ });
    expect(screen.queryAllByRole("button", { name: /^Note actions for/ })).toHaveLength(0);
    expect(rowLink("Alpha Plan")).toHaveAttribute("href", canonicalNotePath(ALPHA_PLAN));
    expect(rowLink("Alpha Group")).toHaveAttribute("href", canonicalNotePath(ALPHA_GROUP));
    expect(screen.getByRole("link", { name: "Alpha Group Groups › Workshop A" })).toBeInTheDocument();

    await waitFor(() => expect(rowLink("Alpha Plan")).toHaveAttribute("aria-current", "page"));
    expect(rowLink("Alpha Group")).not.toHaveAttribute("aria-current");
    expect(rowLink("alpha shared")).not.toHaveAttribute("aria-current");

    fireEvent.click(rowLink("alpha shared"));
    await waitFor(() => expect(rowLink("alpha shared")).toHaveAttribute("aria-current", "page"));
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("notes pending: Loading...; 500: role=alert", async () => {
    stubFetch("pending");
    const first = renderResults("a");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-search")).toHaveClass("flex-1");
    first.unmount();
    vi.unstubAllGlobals();

    stubFetch("error");
    renderResults("a");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-search")).toHaveClass("flex-1");
  });

  it("long title: the title and location elements truncate, the link has min-w-0", async () => {
    stubFetch([note("s1", "L".repeat(120))]);
    renderResults("l");
    const link = await screen.findByRole("link");
    expect(link).toHaveClass("min-w-0");
    const lines = link.querySelectorAll("div");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toHaveClass("truncate");
    expect(within(link).getByText("My notes")).toHaveClass("truncate");
  });
});

describe("SearchResults x folder path", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a search hit on p2: the second line shows the folder path, with the same title text", async () => {
    const p2 = note("p2", "Deep note", { folderId: "A1" });
    const folders = [folderDto({ id: "A", name: "A" }), folderDto({ id: "A1", name: "A1", parentId: "A" })];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify({ folders }), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes") return Promise.resolve(fakeResponse(true, 200, [p2]));
        if (url === "/api/groups") return Promise.resolve(fakeResponse(true, 200, []));
        if (url.startsWith("/api/search?")) return Promise.resolve(fakeResponse(true, 200, { hits: [], nextCursor: null }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderResults("deep");
    await waitFor(() => expect(screen.getByTitle("My notes › A › A1")).toHaveTextContent("My notes › A › A1"));
  });
});

describe("SearchResults x body matches (#93)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    searchUrls = [];
    searchHandler = EMPTY_SEARCH;
  });
  afterEach(() => {
    vi.useRealTimers();
    searchHandler = EMPTY_SEARCH;
  });

  const bodyHit = (n: NoteDto, matchedOn: NoteSearchHitDto["matchedOn"] = "body"): NoteSearchHitDto => ({
    note: n,
    matchedOn,
    matches: matchedOn === "title" ? [] : [{ sectionId: "s1", heading: "", snippet: "body text" }],
  });
  const searchBody = (hits: NoteSearchHitDto[]) => fakeResponse(true, 200, { hits, nextCursor: null });
  /** A /api/search response that can be released from outside. */
  function deferredSearch() {
    const pending: Array<(r: Response) => void> = [];
    searchHandler = () => new Promise<Response>((resolve) => pending.push(resolve));
    return pending;
  }
  const qOf = (url: string) => new URL(url, "http://x").searchParams.get("q");
  const noMatch = () => screen.queryAllByText("No notes match your search.");
  const region = () => screen.getByRole("region", { name: "Search results" });

  /** lazy is a module-level singleton: mount once with real timers first so the later fake-timer cases do not have to wait for the chunk. */
  async function warmLazy() {
    stubFetch(FIXTURE);
    const r = renderResults("warmup");
    await screen.findByRole("region", { name: "Search results" });
    r.unmount();
    searchUrls = [];
  }

  function renderControlled(initial: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (q: string) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ActiveNoteProvider>
            <SearchResults query={q} />
          </ActiveNoteProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const r = render(tree(initial));
    return { ...r, setQuery: (q: string) => r.rerender(tree(q)) };
  }

  it("noMatch: title 0 + body pending: absent and \"Searching...\" shown; empty reply: one; error: absent; stale empty batch: absent", async () => {
    stubFetch(FIXTURE);
    let pending = deferredSearch();
    const a = renderResults("zzz");
    await waitFor(() => expect(searchUrls.length).toBe(1));
    expect(await screen.findByText("Searching note text…")).toBeInTheDocument();
    expect(noMatch()).toHaveLength(0);
    act(() => pending[0]!(searchBody([])));
    await waitFor(() => expect(noMatch()).toHaveLength(1));
    a.unmount();

    searchHandler = () => fakeResponse(false, 500, { error: { code: "internal", message: "x" } });
    const b = renderResults("yyy");
    expect(await screen.findByText("Couldn't search note text.")).toBeInTheDocument();
    expect(noMatch()).toHaveLength(0);
    b.unmount();

    // Stale empty batch: the old batch itself is empty (title 0, body 0 -> noMatch first); after the text changes, being in the debounce or with the new request not back are both stale -> noMatch disappears
    // (the old empty batch cannot be used to conclude the new text has no hits too); once the new batch comes back empty noMatch reappears. If the old batch had results, rows.length > 0 would hide it anyway, which would not show whether `!stale` was removed.
    searchHandler = EMPTY_SEARCH;
    const c = renderControlled("qqq");
    await waitFor(() => expect(noMatch()).toHaveLength(1));
    pending = deferredSearch();
    c.setQuery("qqqq");
    expect(noMatch()).toHaveLength(0); // during the debounce: stale (query !== debounced)
    await waitFor(() => expect(searchUrls.some((u) => qOf(u) === "qqqq")).toBe(true));
    expect(noMatch()).toHaveLength(0); // new request in flight: stale (placeholder)
    act(() => pending[0]!(searchBody([])));
    await waitFor(() => expect(noMatch()).toHaveLength(1));
  });

  it("title 0 but body hits in 2 notes: no noMatch", async () => {
    stubFetch(FIXTURE);
    searchHandler = () => searchBody([bodyHit(BETA), bodyHit(ALPHA_PLAN)]);
    renderResults("zzz");
    await waitFor(() => expect(within(region()).getAllByTestId("search-hit")).toHaveLength(2));
    expect(noMatch()).toHaveLength(0);
  });

  it("merge and dedup: a note hit in both title and body appears as one row (with a snippet); a title-only note is one row without a snippet; the count is the number of listed items", async () => {
    stubFetch(FIXTURE);
    searchHandler = () => searchBody([bodyHit(ALPHA_PLAN, "both"), bodyHit(ALPHA_SHARED, "title")]);
    renderResults("alpha");
    await waitFor(() => expect(within(region()).getAllByTestId("body-match")).toHaveLength(1));
    const rows = within(region()).getAllByTestId("search-hit");
    expect(rows).toHaveLength(3); // title hits: Alpha Plan, Alpha Group, alpha shared
    expect(screen.getAllByRole("link", { name: /^Alpha Plan/ })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: /^alpha shared/ })).toHaveLength(1);
    const planRow = rows.find((r) => within(r).queryByRole("link", { name: /^Alpha Plan/ }))!;
    const sharedRow = rows.find((r) => within(r).queryByRole("link", { name: /^alpha shared/ }))!;
    expect(within(planRow).getAllByTestId("body-match")).toHaveLength(1);
    expect(within(sharedRow).queryByTestId("body-match")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("3 results");
  });

  it("several hits in one note: one item per hit, and the note-count line counts items (3 title-only notes + 1 note with 3 hits = 6 results), not notes (4)", async () => {
    stubFetch(FIXTURE);
    const multi: NoteSearchHitDto = {
      note: BETA,
      matchedOn: "body",
      matches: [
        { sectionId: "s1", heading: "", snippet: "alpha one" },
        { sectionId: "s2", heading: "", snippet: "alpha two" },
        { sectionId: "s3", heading: "", snippet: "alpha three" },
      ],
    };
    searchHandler = () => searchBody([multi]);
    renderResults("alpha");
    await waitFor(() => expect(within(region()).getAllByTestId("body-match")).toHaveLength(3));
    const titleOnly = 3; // Alpha Plan, Alpha Group, alpha shared have only title hits
    expect(within(region()).getAllByTestId("search-hit")).toHaveLength(titleOnly + 3);
    expect(screen.getByRole("status")).toHaveTextContent(`${titleOnly + 3} results`);
    expect(screen.getByRole("status")).not.toHaveTextContent("4 results");
  });

  it("body-only notes come after title hits (title hits in list order, the rest in server order)", async () => {
    stubFetch(FIXTURE);
    searchHandler = () => searchBody([bodyHit(BETA), bodyHit(ALPHA_PLAN, "both")]);
    renderResults("alpha");
    await screen.findByRole("link", { name: /^Beta/ });
    const titles = within(region()).getAllByTestId("search-hit").map((r) => within(r).getAllByRole("link")[0]!.querySelector("div")!.textContent);
    expect(titles.at(-1)).toBe("Beta");
  });

  it("layout: the nearest overflow-y-auto ancestor of the body section is the container holding the title list; the status is not inside it; the sidebar has one status", async () => {
    stubFetch(FIXTURE);
    renderResults("alpha");
    const body = await screen.findByTestId("sidebar-search-results");
    const scroller = body.closest(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    expect(scroller!.contains(screen.getAllByRole("link", { name: /^Alpha Plan/ })[0]!)).toBe(true);
    expect(scroller!.contains(screen.getByRole("status"))).toBe(false);
    expect(within(screen.getByTestId("sidebar-search")).getAllByRole("status")).toHaveLength(1);
  });

  it("debounce: a -> ab -> abc -> abcd 100 ms apart, then advancing past 300 ms: /api/search is called once with q=abcd", async () => {
    await warmLazy();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const r = renderControlled("a");
    await screen.findByRole("status");
    for (const q of ["ab", "abc", "abcd"]) {
      r.setQuery(q);
      await act(async () => vi.advanceTimersByTime(100));
    }
    await act(async () => vi.advanceTimersByTime(300));
    await waitFor(() => expect(searchUrls.length).toBe(1));
    await act(async () => vi.advanceTimersByTime(400));
    expect(searchUrls.map(qOf)).toEqual(["abcd"]);
  });

  it("remount does not resend: abcd comes back -> a (lazy unmounts) -> ab within 100 ms (remount) -> advancing past 300 ms: only one more request, q=ab", async () => {
    await warmLazy();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const r = renderControlled("abcd");
    await waitFor(() => expect(searchUrls.map(qOf)).toEqual(["abcd"]));
    await screen.findByText("0 results");
    r.setQuery("a");
    expect(screen.queryByTestId("sidebar-search-results")).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(50));
    r.setQuery("ab");
    await act(async () => vi.advanceTimersByTime(50));
    expect(searchUrls.map(qOf)).toEqual(["abcd"]);
    await act(async () => vi.advanceTimersByTime(300));
    await waitFor(() => expect(searchUrls.map(qOf)).toEqual(["abcd", "ab"]));
    await act(async () => vi.advanceTimersByTime(400));
    expect(searchUrls.map(qOf)).toEqual(["abcd", "ab"]);
  });
});

describe("highlightTitle", () => {
  it("not found, or lowercasing changes the length: returns the original string", () => {
    expect(highlightTitle("Beta", "zz")).toBe("Beta");
    expect(highlightTitle("İstanbul", "stan")).toBe("İstanbul");
  });

  it("two hits: only the first is marked, original case kept", () => {
    const { container } = render(<>{highlightTitle("Alpha alpha", "alpha")}</>);
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent("Alpha");
    expect(marks[0].previousSibling).toBeNull();
    expect(container.textContent).toBe("Alpha alpha");
    expect(marks[0].nextSibling?.textContent).toBe(" alpha");
  });
});
