import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useNavigate } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "./App";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

/**
 * Pins that App.tsx's `LazyPageRoute` really wraps each whole-page lazy route in `LazyRouteErrorBoundary`, puts `ChunkLoadBeacon` inside Suspense, and keys boundary instances per `chunk`. The boundary's own behaviour is in ErrorBoundary.test.tsx, where a hand-assembled shape says nothing about App.tsx's; same approach as App.errorBoundary.test.tsx.
 *
 * ⚠⚠ Each page's "throw" case must be the first case in this file to trigger that page's lazy (the lazies of AdminSections (the site modal's six sections, #247), RegisterPage, ... are module-level singletons, and only the first trigger passes through a suspend period). The "beacon misplaced outside Suspense" guard relies on that pending period: a misplaced beacon commits during it and clears the seeded flag, so componentDidCatch wrongly treats the error as the first one and reloads into the loading screen; the error-text assertion and the "reload not called" assertion both go red.
 *
 * Precondition: each throw case begins by asserting `mockPages.<page>Loaded === false`. The mock factory runs only on that page's first dynamic import and sets it to true, so this turns the "this case is the first trigger" ordering assumption into a failing assertion. Don't use "not the error screen right after render" as the precondition instead: /admin is under RequireAuth and waits on an async /api/auth/me, so right after render it is not the error screen whether or not the lazy was loaded before (an admin ok case moved ahead of the throw case, with a misplaced beacon, would leave the admin case green).
 */

// vi.mock is hoisted: shared state goes through vi.hoisted; read the mode inside the mock component's function body (React.lazy caches the import result forever and the factory runs once). `*Loaded` is set by the factory: the factory running means that page's lazy was imported for the first time.
const mockPages = vi.hoisted(() => ({
  admin: "throw" as "throw" | "ok",
  register: "throw" as "throw" | "ok",
  adminLoaded: false,
  registerLoaded: false,
}));

vi.mock("./components/admin/AdminSections", () => {
  mockPages.adminLoaded = true;
  function make(label: string) {
    return function AdminSectionMock() {
      if (mockPages.admin === "throw") {
        throw new Error("Failed to fetch dynamically imported module: https://x/assets/AdminSections-abc.js");
      }
      return <p>{label}</p>;
    };
  }
  return {
    AdminUsersSection: make("adminsections-mock-ok"),
    AdminGroupsSection: make("adminsections-groups"),
    AdminLoginSection: make("adminsections-login"),
    AdminStorageSection: make("adminsections-storage"),
    AdminAiSection: make("adminsections-ai"),
    AdminLimitsSection: make("adminsections-limits"),
  };
});

vi.mock("./pages/RegisterPage", () => {
  mockPages.registerLoaded = true;
  return {
    default: function RegisterPageMock() {
      if (mockPages.register === "throw") {
        throw new Error("Failed to fetch dynamically imported module: https://x/assets/RegisterPage-abc.js");
      }
      return <p>registerpage-mock-ok</p>;
    },
  };
});

vi.mock("./pages/LinkAccountPage", () => ({
  default: function LinkAccountPageMock() {
    return <p>linkaccountpage-mock-ok</p>;
  },
}));

const ADMIN_FLAG = "knotebook:chunk-reload:admin";
const REGISTER_FLAG = "knotebook:chunk-reload:register";
const LINK_ACCOUNT_FLAG = "knotebook:chunk-reload:link-account";
const CHUNK_ERROR_TEXT = "Couldn't load this page — check your connection, or a new version may have been deployed.";

const ADMIN_USER: UserDto = {
  id: "u1",
  email: "admin@example.com",
  handle: "tester",
  displayName: "Admin",
  isAdmin: true,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

function fakeResponse(ok: boolean, status: number, body?: unknown): Response {
  return {
    ok,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as unknown as Response;
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(true, 200, ADMIN_USER));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/groups" || url === "/api/notes") return Promise.resolve(fakeResponse(true, 200, []));
      return Promise.resolve(fakeResponse(false, 404));
    }),
  );
}

let navigateFn: ((to: string) => void) | null = null;
function NavigateHandle() {
  const navigate = useNavigate();
  navigateFn = navigate;
  return null;
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
          <NavigateHandle />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

let reload: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  sessionStorage.clear();
  mockPages.admin = "throw";
  mockPages.register = "throw";
  navigateFn = null;
  await i18n.changeLanguage("en");
  stubFetch();
  reload = vi.fn();
  vi.stubGlobal("location", { ...window.location, reload });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App route tree - ErrorBoundary wiring for whole-page lazy routes (#201)", () => {
  it("/admin/users (frame=inline): AdminSections chunk failure (flag set) -> error and retry in the site modal's right card, shell and nav stay, no reload, flag kept", async () => {
    expect(mockPages.adminLoaded).toBe(false);
    sessionStorage.setItem(ADMIN_FLAG, "1");
    renderAt("/admin/users");

    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    await waitFor(() => expect(within(dialog).getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument());
    expect(within(dialog).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(within(dialog).getByRole("navigation", { name: "Site admin" })).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(ADMIN_FLAG)).toBe("1");
  });

  it("/admin/users: AdminSections renders normally (flag set) -> beacon clears the admin flag", async () => {
    sessionStorage.setItem(ADMIN_FLAG, "1"); // Seeded: starting empty would pass even if the beacon were deleted
    mockPages.admin = "ok";
    renderAt("/admin/users");

    await waitFor(() => expect(screen.getByText("adminsections-mock-ok")).toBeInTheDocument());
    expect(sessionStorage.getItem(ADMIN_FLAG)).toBeNull();
  });

  it("all six site modal sections come from one AdminSections module: /admin/limits renders its AdminLimitsSection", async () => {
    mockPages.admin = "ok";
    renderAt("/admin/limits");

    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    await waitFor(() => expect(within(dialog).getByText("adminsections-limits")).toBeInTheDocument());
    expect(within(dialog).getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual([
      "/admin/users",
      "/admin/groups",
      "/admin/login",
      "/admin/storage",
      "/admin/ai",
      "/admin/limits",
    ]);
  });

  it("/register (frame=page): RegisterPage chunk failure (flag set) -> error screen with retry, no reload, flag kept", async () => {
    expect(mockPages.registerLoaded).toBe(false);
    sessionStorage.setItem(REGISTER_FLAG, "1");
    renderAt("/register");

    await waitFor(() => expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(REGISTER_FLAG)).toBe("1");
  });

  it("/register: RegisterPage renders normally (flag set) -> beacon clears the register flag", async () => {
    sessionStorage.setItem(REGISTER_FLAG, "1");
    mockPages.register = "ok";
    renderAt("/register");

    await waitFor(() => expect(screen.getByText("registerpage-mock-ok")).toBeInTheDocument());
    expect(sessionStorage.getItem(REGISTER_FLAG)).toBeNull();
  });

  it("boundary is keyed per chunk: SPA navigation from the /register error screen to /link-account shows the link-account page without the register error", async () => {
    sessionStorage.setItem(REGISTER_FLAG, "1");
    sessionStorage.setItem(LINK_ACCOUNT_FLAG, "1");
    renderAt("/register");
    await waitFor(() => expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument());

    act(() => navigateFn?.("/link-account"));

    // If one boundary instance were shared by both routes, the error state would persist (resetKey unchanged -> no reset) and the link-account page would never appear.
    await waitFor(() => expect(screen.getByText("linkaccountpage-mock-ok")).toBeInTheDocument());
    expect(screen.queryByText(CHUNK_ERROR_TEXT)).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(LINK_ACCOUNT_FLAG)).toBeNull();
    expect(sessionStorage.getItem(REGISTER_FLAG)).toBe("1");
  });
});
