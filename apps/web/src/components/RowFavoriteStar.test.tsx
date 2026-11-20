import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { useFavoriteLookup } from "@/api/favorites";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { personalNote } from "@/test/select-fixtures";
import { RowFavoriteStar } from "./RowFavoriteStar";

const A = personalNote({ id: "note-a", title: "Alpha" });
const B = personalNote({ id: "note-b", title: "Beta" });
const C = personalNote({ id: "note-c", title: "Gamma" });

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const hang = () => new Promise<Response>(() => {});

interface FavServer {
  favorites: string[];
  get: "ok" | "pending" | "error";
  put: "ok" | "pending" | 404;
  del: "ok" | "pending";
  calls: string[];
}

function stubServer(init: Partial<Omit<FavServer, "calls">> = {}): FavServer {
  const server: FavServer = { favorites: [], get: "ok", put: "ok", del: "ok", calls: [], ...init };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, request?: RequestInit) => {
      const url = String(input);
      const method = (request?.method ?? "GET").toUpperCase();
      server.calls.push(`${method} ${url}`);
      if (url === "/api/favorites" && method === "GET") {
        if (server.get === "pending") return hang();
        if (server.get === "error") return Promise.resolve(jsonResponse({ error: { code: "internal", message: "boom" } }, 500));
        return Promise.resolve(jsonResponse(server.favorites.map((noteId) => ({ noteId, favoritedAt: "2026-03-01T00:00:00.000Z" }))));
      }
      const target = /^\/api\/favorites\/(.+)$/.exec(url)?.[1];
      if (target !== undefined && method === "PUT") {
        if (server.put === "pending") return hang();
        if (server.put === 404) return Promise.resolve(jsonResponse({ error: { code: "not_found", message: "Not found" } }, 404));
        server.favorites = [target, ...server.favorites];
        return Promise.resolve(jsonResponse({ noteId: target, favoritedAt: "2026-03-02T00:00:00.000Z" }));
      }
      if (target !== undefined && method === "DELETE") {
        if (server.del === "pending") return hang();
        server.favorites = server.favorites.filter((id) => id !== target);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(jsonResponse({ error: { code: "not_found", message: "unexpected" } }, 404));
    }),
  );
  return server;
}

const count = (server: FavServer, call: string) => server.calls.filter((c) => c === call).length;

/**
 * Minimal stand-in for the row list: same behaviour as `NoteList` - one `useFavoriteLookup`, no stars until ready;
 * with `onlyFavorites` it lists only favorites (Favorites tab: the row unmounts after removal).
 */
function Rows({ notes, onlyFavorites = false }: { notes: NoteDto[]; onlyFavorites?: boolean }) {
  const lookup = useFavoriteLookup();
  const shown = onlyFavorites ? notes.filter((n) => lookup.ids.has(n.id)) : notes;
  return (
    <div data-sidebar-instance="">
      <div role="tabpanel" tabIndex={0} aria-label="panel">
        <ul>
          {shown.map((note) => (
            <li key={note.id} data-node-kind="note" data-node-id={note.id} className="group/noterow">
              <a href={`/notes/${note.id}`}>{note.title}</a>
              {lookup.ready && <RowFavoriteStar note={note} favorite={lookup.ids.has(note.id)} pending={lookup.pendingIds.has(note.id)} />}
              <button type="button">menu</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function setup(notes: NoteDto[] = [A], opts: { onlyFavorites?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Rows notes={notes} onlyFavorites={opts.onlyFavorites} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { queryClient };
}

const rowOf = (note: NoteDto) => document.querySelector(`[data-node-id="${note.id}"]`) as HTMLElement;
const starOf = (note: NoteDto) => within(rowOf(note)).getByRole("button", { name: "Favorite" });
const star = () => starOf(A);
const ready = () => waitFor(() => expect(star()).toBeInTheDocument());

describe("RowFavoriteStar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("in favorites: name fixed as Favorite, aria-pressed=true, title is remove, filled star, no float-in class", async () => {
    stubServer({ favorites: [A.id] });
    setup();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    expect(star()).toHaveAttribute("title", "Remove from favorites");
    expect(star().querySelector("svg")).toHaveAttribute("fill", "currentColor");
    expect(star().className).not.toContain("opacity-0");
    // Mouse: always shown; touch and devices without hover: this button is hidden entirely, replaced by a non-clickable marker in the same slot.
    expect(star().className).toContain("[@media(hover:none)]:hidden");
    expect(star().className).toContain("[@media(pointer:coarse)]:hidden");
    expect(star().className).toContain("text-brand");
  });



  it("not in favorites: name is still Favorite, aria-pressed=false, title is add, hollow star, carries the float-in class (hidden on touch)", async () => {
    stubServer();
    setup();
    await ready();
    expect(star()).toHaveAttribute("aria-pressed", "false");
    expect(star()).toHaveAttribute("title", "Add to favorites");
    expect(star().querySelector("svg")).toHaveAttribute("fill", "none");
    const classes = star().className.split(/\s+/);
    expect(classes).toContain("opacity-0");
    expect(classes).toContain("[@media(hover:none)]:hidden");
    expect(classes).toContain("[@media(pointer:coarse)]:hidden");
    expect(classes).toContain("group-hover/noterow:opacity-100");
  });

  it("24px icon button, no aria-describedby, native button", async () => {
    stubServer();
    setup();
    await ready();
    expect(star().tagName).toBe("BUTTON");
    expect(star()).toHaveAttribute("type", "button");
    expect(star().className).toContain("h-6");
    expect(star().className).toContain("w-6");
    expect(star().className).toContain("shrink-0");
    expect(star()).not.toHaveAttribute("aria-describedby");
  });

  it("list not arrived or load failed -> no star rendered", async () => {
    stubServer({ get: "pending" });
    setup();
    expect(screen.queryByRole("button", { name: "Favorite" })).toBeNull();
    cleanup();
    stubServer({ get: "error" });
    setup();
    await waitFor(() => expect(screen.getByRole("link", { name: "Alpha" })).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: "Favorite" })).toBeNull();
  });

  it("click when not added: optimistically pressed, one PUT, no dialog, no toast", async () => {
    const server = stubServer();
    setup();
    await ready();
    fireEvent.click(star());
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    expect(count(server, `PUT /api/favorites/${A.id}`)).toBe(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(star()).not.toHaveAttribute("aria-disabled"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("PUT fails -> error toast, back to not pressed", async () => {
    stubServer({ put: 404 });
    setup();
    await ready();
    fireEvent.click(star());
    expect(await screen.findByText("We couldn't find what you were looking for.")).toBeInTheDocument();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "false"));
  });

  it("click when added: opens the confirm dialog, no DELETE yet; neither Cancel nor Esc sends anything, focus returns to the star", async () => {
    const server = stubServer({ favorites: [A.id] });
    setup();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(star());
    const dialog = await screen.findByRole("dialog", { name: "Remove from favorites?" });
    expect(count(server, `DELETE /api/favorites/${A.id}`)).toBe(0);
    expect(dialog).toHaveTextContent(`"${A.title}" will be removed`);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(star()).toHaveFocus());

    fireEvent.click(star());
    const again = await screen.findByRole("dialog");
    fireEvent.keyDown(again, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(star()).toHaveFocus());
    expect(count(server, `DELETE /api/favorites/${A.id}`)).toBe(0);
    expect(star()).toHaveAttribute("aria-pressed", "true");
  });

  it("confirm removal (tab where the star stays) -> one DELETE, not pressed, no toast, focus returns to the star", async () => {
    const server = stubServer({ favorites: [A.id] });
    setup();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(star());
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(count(server, `DELETE /api/favorites/${A.id}`)).toBe(1);
    expect(star()).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("status")).toBeNull();
    await waitFor(() => expect(star()).toHaveFocus());
  });

  it("Favorites tab: after the row unmounts focus lands on the next row's link; no next row -> previous row; only one row left -> tabpanel", async () => {
    stubServer({ favorites: [A.id, B.id, C.id] });
    setup([A, B, C], { onlyFavorites: true });
    await waitFor(() => expect(starOf(B)).toBeInTheDocument());

    fireEvent.click(starOf(B));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(rowOf(B)).toBeNull());
    await waitFor(() => expect(within(rowOf(C)).getByRole("link", { name: "Gamma" })).toHaveFocus());

    fireEvent.click(starOf(C));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(rowOf(C)).toBeNull());
    await waitFor(() => expect(within(rowOf(A)).getByRole("link", { name: "Alpha" })).toHaveFocus());

    fireEvent.click(starOf(A));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(rowOf(A)).toBeNull());
    await waitFor(() => expect(screen.getByRole("tabpanel")).toHaveFocus());
  });

  it("while sending: aria-disabled=true, no disabled attribute, focus stays on the star, repeated clicks send only once", async () => {
    const server = stubServer({ put: "pending" });
    setup();
    await ready();
    star().focus();
    fireEvent.click(star());
    await waitFor(() => expect(star()).toHaveAttribute("aria-disabled", "true"));
    expect(star()).not.toHaveAttribute("disabled");
    expect(star()).toHaveFocus();
    fireEvent.click(star());
    fireEvent.click(star());
    expect(count(server, `PUT /api/favorites/${A.id}`)).toBe(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
  });

  it("in the same list only the note being sent is aria-disabled", async () => {
    stubServer({ put: "pending" });
    setup([A, B]);
    await waitFor(() => expect(starOf(A)).toBeInTheDocument());
    fireEvent.click(starOf(A));
    await waitFor(() => expect(starOf(A)).toHaveAttribute("aria-disabled", "true"));
    expect(starOf(B)).not.toHaveAttribute("aria-disabled");
  });
});
