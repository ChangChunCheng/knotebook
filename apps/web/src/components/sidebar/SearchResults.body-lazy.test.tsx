import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { SearchResults } from "./SearchResults";

/**
 * #93: when the lazy chunk of the body section loads. The lazy module is a module-level singleton and the `vi.mock` factory runs only once,
 * so the cases in this file are **ordered**: first the three kinds of text that must not load, then "two characters load the chunk first, before any request is sent",
 * and only last the `" ab "` that does load.
 */
const flags = vi.hoisted(() => ({ bodySearchLoaded: false }));
vi.mock("@/components/sidebar/BodySearchLazy", async (importOriginal) => {
  flags.bodySearchLoaded = true;
  return await importOriginal();
});

const NOTE: NoteDto = {
  id: "n1", title: "Beta", ownerId: "u1", role: "owner", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "slug-n1", slugIsCustom: false, prevSlug: null, ownerHandle: "o", lastEdited: null, group: null, groupId: null, folderId: null,
  permissions: OWNER_PERMS,
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
let searchUrls: string[] = [];

beforeEach(async () => {
  await i18n.changeLanguage("en");
  searchUrls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/notes") return Promise.resolve(json([NOTE]));
      if (url === "/api/groups") return Promise.resolve(json([]));
      if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
      if (url.startsWith("/api/search?")) {
        searchUrls.push(url);
        return Promise.resolve(json({ hits: [], nextCursor: null }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
const settle = () => new Promise((r) => setTimeout(r, 400)); // past the 300 ms debounce

describe("when the body section loads", () => {
  it("only whitespace typed: no /api/search, no chunk load; title 0 gives noMatch", async () => {
    renderControlled("  ");
    expect(await screen.findByText("No notes match your search.")).toBeInTheDocument();
    await settle();
    expect(searchUrls).toEqual([]);
    expect(flags.bodySearchLoaded).toBe(false);
  });

  it("one character: the hint sentence, no request, no load; title 0 gives noMatch", async () => {
    renderControlled("z");
    expect(await screen.findByText("Type one more character to search note text too.")).toBeInTheDocument();
    expect(screen.getByText("No notes match your search.")).toBeInTheDocument();
    await settle();
    expect(searchUrls).toEqual([]);
    expect(flags.bodySearchLoaded).toBe(false);
  });

  it("201 characters: the hint sentence, no request, no load", async () => {
    renderControlled("b".repeat(201));
    expect(await screen.findByText("Too long to search note text; matching titles only.")).toBeInTheDocument();
    await settle();
    expect(searchUrls).toEqual([]);
    expect(flags.bodySearchLoaded).toBe(false);
  });

  it("the chunk loads as soon as there are 2 characters, even before 300 ms have passed and before any request is sent", async () => {
    const r = renderControlled("b");
    await screen.findByRole("link", { name: /^Beta/ }); // the list has arrived (SearchResults is past its early return)
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); // the debounce's setTimeout never expires by itself
    act(() => r.setQuery("be"));
    // Not waitFor: RTL's asyncWrapper awaits a setTimeout(0), which hangs when faked. Yield through setImmediate (not faked) instead.
    for (let i = 0; i < 500 && !flags.bodySearchLoaded; i += 1) await new Promise((res) => setImmediate(res));
    expect(flags.bodySearchLoaded).toBe(true);
    expect(searchUrls).toEqual([]);
  });

  it("\" ab \" sends q=ab", async () => {
    renderControlled(" ab ");
    await waitFor(() => expect(searchUrls.length).toBe(1));
    expect(new URL(searchUrls[0]!, "http://x").searchParams.get("q")).toBe("ab");
  });
});
