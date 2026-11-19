import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { OWNER_PERMS } from "@/test/fixtures";
import { FavoriteToggle } from "./FavoriteToggle";

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Alpha",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "alpha",
  slugIsCustom: true,
  prevSlug: null,
  ownerHandle: "alice",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const hang = () => new Promise<Response>(() => {});

interface FavServer {
  favorites: string[];
  get: "ok" | "pending";
  put: "ok" | "pending" | 404;
  del: "ok" | "pending" | 429;
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
        if (server.del === 429) return Promise.resolve(jsonResponse({ error: { code: "too_many_requests", message: "slow" } }, 429));
        server.favorites = server.favorites.filter((id) => id !== target);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(jsonResponse({ error: { code: "not_found", message: "unexpected" } }, 404));
    }),
  );
  return server;
}

const count = (server: FavServer, call: string) => server.calls.filter((c) => c === call).length;

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <FavoriteToggle note={NOTE} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { queryClient };
}

const star = () => screen.getByRole("button", { name: "Favorite" });
const ready = () => waitFor(() => expect(star()).not.toBeDisabled());

describe("FavoriteToggle", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("in favorites: accessible name is still Favorite, aria-pressed=true, title is remove, filled star", async () => {
    stubServer({ favorites: [NOTE.id] });
    setup();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    expect(star()).toHaveAttribute("title", "Remove from favorites");
    expect(star().querySelector("svg")).toHaveAttribute("fill", "currentColor");
  });

  it("not in favorites: aria-pressed=false, title is add, hollow star", async () => {
    stubServer();
    setup();
    await ready();
    expect(star()).toHaveAttribute("aria-pressed", "false");
    expect(star()).toHaveAttribute("title", "Add to favorites");
    expect(star().querySelector("svg")).toHaveAttribute("fill", "none");
  });

  it("list not arrived yet -> disabled, aria-pressed=false", () => {
    stubServer({ get: "pending" });
    setup();
    expect(star()).toBeDisabled();
    expect(star()).toHaveAttribute("aria-pressed", "false");
  });

  it("click when not added: optimistically pressed, sends PUT, no dialog, no toast", async () => {
    const server = stubServer();
    setup();
    await ready();
    fireEvent.click(star());
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    expect(count(server, `PUT /api/favorites/${NOTE.id}`)).toBe(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(star()).not.toHaveAttribute("aria-disabled"));
    expect(screen.queryByText("Added to favorites")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("PUT returns 404 -> back to not pressed, error toast", async () => {
    stubServer({ put: 404 });
    setup();
    await ready();
    fireEvent.click(star());
    expect(await screen.findByText("We couldn't find what you were looking for.")).toBeInTheDocument();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "false"));
  });

  it("click when added: opens the confirm dialog with no request sent; Cancel -> nothing sent, focus returns to the star", async () => {
    const server = stubServer({ favorites: [NOTE.id] });
    setup();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(star());
    const dialog = await screen.findByRole("dialog", { name: "Remove from favorites?" });
    expect(count(server, `DELETE /api/favorites/${NOTE.id}`)).toBe(0);
    expect(dialog).toHaveTextContent(`"${NOTE.title}" will be removed`);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(count(server, `DELETE /api/favorites/${NOTE.id}`)).toBe(0);
    expect(star()).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(star()).toHaveFocus());
  });

  it("confirm removal -> sends DELETE; on success not pressed, dialog closed, no toast, focus returns to the star", async () => {
    const server = stubServer({ favorites: [NOTE.id] });
    setup();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(star());
    const dialog = await screen.findByRole("dialog", { name: "Remove from favorites?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(count(server, `DELETE /api/favorites/${NOTE.id}`)).toBe(1);
    expect(star()).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Removed from favorites")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    await waitFor(() => expect(star()).toHaveFocus());
  });

  it("DELETE returns 429 -> dialog closed, error toast, still pressed, focus returns to the star", async () => {
    stubServer({ favorites: [NOTE.id], del: 429 });
    setup();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(star());
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Too many requests. Please slow down.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(star()).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(star()).toHaveFocus());
  });

  it("while sending: aria-disabled=true, no disabled attribute, focus stays on the star, a double click sends only once", async () => {
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
    expect(count(server, `PUT /api/favorites/${NOTE.id}`)).toBe(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clicking again while add is in flight (already pressed): no confirm dialog, no DELETE", async () => {
    const server = stubServer({ put: "pending" });
    setup();
    await ready();
    fireEvent.click(star());
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(star());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
  });

  it("while removal is in flight: dialog doesn't close, Esc has no effect, DELETE is sent once, the star is aria-disabled", async () => {
    const server = stubServer({ favorites: [NOTE.id], del: "pending" });
    setup();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(star());
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(count(server, `DELETE /api/favorites/${NOTE.id}`)).toBe(1));
    // With the dialog open Radix marks everything outside it aria-hidden, hence the hidden query.
    const hiddenStar = screen.getByRole("button", { name: "Favorite", hidden: true });
    await waitFor(() => expect(hiddenStar).toHaveAttribute("aria-disabled", "true"));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(count(server, `DELETE /api/favorites/${NOTE.id}`)).toBe(1);
  });

  it("className: shrink-0 and @max-[18rem]:hidden, no separate hidden class", async () => {
    stubServer();
    setup();
    await ready();
    const classes = star().className.split(/\s+/);
    expect(classes).toContain("shrink-0");
    expect(classes).toContain("@max-[18rem]:hidden");
    expect(classes).not.toContain("hidden");
    expect(classes.some((c) => c.startsWith("@min-"))).toBe(false);
  });
});
