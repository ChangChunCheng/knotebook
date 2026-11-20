import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "./App";

// PublicNotePage is replaced by a stub that resolves only when the test releases it, giving the Suspense fallback an assertable window; the stub itself does no fetch, so "the whole /p/ route (fallback period included) calls no API" is a single assertion that fetch was never called.
// A fixed delay (as in App.test.tsx) would tie correctness to wall-clock time and leave a flake window on slow CI; a manual gate is deterministic: the first case never releases it (the fallback period holds throughout), the second releases it itself.
// ⚠ The three cases share one module-level gate and React.lazy's import cache, so order matters, don't reorder: the never-release case goes first, and the third (#122 alias form) relies on the second having released the gate so it can render directly.
const chunkGate = vi.hoisted(() => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
});
vi.mock("./pages/PublicNotePage", async () => {
  await chunkGate.promise;
  return { default: () => <p>public-note-page-stub</p> };
});

const TOKEN = "abcDEF123_-".repeat(4).slice(0, 43);

function renderApp(entry = `/p/${TOKEN}`) {
  // Any fetch is a violation: both /p/ forms are outside RequireAuth, so an anonymous visitor must not hit /api/auth/me (a regression wrapping them in RequireAuth shows up here: the session query makes fetchSpy record a call).
  const fetchSpy = vi.fn(() => Promise.reject(new Error("public route must not fetch")));
  vi.stubGlobal("fetch", fetchSpy);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return fetchSpy;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App route tree - both /p/ forms sit outside RequireAuth (#72, #122)", () => {
  it("while the chunk loads: public-page-specific fallback (minimal loading, no AppShell sidebar); zero fetches throughout", async () => {
    const fetchSpy = renderApp();

    // Gate not released, so the chunk stays pending and the fallback period holds: loading is present and the AppShell landmark (New note) must not be; reusing NotePageFallback would expose the sidebar (and the session/notes queries) to anonymous visitors.
    await waitFor(() => expect(screen.getByText("Loading…")).toBeInTheDocument());
    expect(screen.queryByText("New note")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("chunk resolved: page renders, no redirect to /login, zero fetches (signed-out users are not redirected)", async () => {
    const fetchSpy = renderApp();

    chunkGate.release();
    await waitFor(() => expect(screen.getByText("public-note-page-stub")).toBeInTheDocument());
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("alias two-segment form /p/<handle>/<slug> (#122): also outside RequireAuth, zero fetches", async () => {
    // The gate was released by the previous case (module-level cache), so this renders directly. Extends the zero-fetch guard to the new form: if the two-segment form were mounted inside RequireAuth, the session query would make fetchSpy record a call.
    const fetchSpy = renderApp("/p/alice/my-doc");
    await waitFor(() => expect(screen.getByText("public-note-page-stub")).toBeInTheDocument());
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
