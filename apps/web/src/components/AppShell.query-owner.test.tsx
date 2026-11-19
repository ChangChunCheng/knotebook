import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarQueryProvider } from "@/lib/sidebar-query";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts } from "@/components/ui/toast";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { AppShell } from "./AppShell";

/**
 * The sidebar search text lives at App level (kept across home/note shell swaps), so it belongs to a user: after logout and a different login it must not leak to the next person (B's home search box would carry A's text and send body search as B).
 * AppShell calls `claim(user.id)` on mount when the session has a user.
 */
const user = (id: string) => ({ id, email: `${id}@example.com`, handle: id, displayName: id, isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null }) satisfies UserDto;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const NOTES: NoteDto[] = [];

let gate: (show: boolean) => void = () => {};
function Harness() {
  const [show, setShow] = useState(true);
  gate = setShow;
  return show ? <AppShell>{null}</AppShell> : null;
}
const box = () => screen.getAllByRole("textbox", { name: "Search notes" })[0] as HTMLInputElement;

describe("search text owner (#369)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/auth/me") return Promise.resolve(json(user("u1")));
        if (url === "/api/groups") return Promise.resolve(json([]));
        if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
        if (url === "/api/notes") return Promise.resolve(json(NOTES));
        if (url.startsWith("/api/search?")) return Promise.resolve(json({ hits: [], nextCursor: null }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ThemeProvider>
          <MemoryRouter>
            <ActiveNoteProvider>
              <SidebarQueryProvider>
                <Harness />
              </SidebarQueryProvider>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    return qc;
  }

  it("a different user logs in (logout -> B logs in, same tab) -> B's search box is empty", async () => {
    const qc = setup();
    await waitFor(() => expect(qc.getQueryData(SESSION_QUERY_KEY)).toEqual(user("u1")));
    fireEvent.change(box(), { target: { value: "needle" } });
    expect(box().value).toBe("needle");
    act(() => gate(false)); // leave the sidebar pages (logout goes to /login)
    act(() => void qc.setQueryData(SESSION_QUERY_KEY, null));
    act(() => void qc.setQueryData(SESSION_QUERY_KEY, user("u2")));
    act(() => gate(true));
    await waitFor(() => expect(box().value).toBe(""));
  });

  it("same user's session refresh (new object, same id) or returning to a sidebar page -> search text is kept", async () => {
    const qc = setup();
    await waitFor(() => expect(qc.getQueryData(SESSION_QUERY_KEY)).toEqual(user("u1")));
    fireEvent.change(box(), { target: { value: "needle" } });
    act(() => void qc.setQueryData(SESSION_QUERY_KEY, { ...user("u1"), displayName: "renamed" }));
    expect(box().value).toBe("needle");
    act(() => gate(false));
    act(() => gate(true));
    await waitFor(() => expect(box().value).toBe("needle"));
  });
});
