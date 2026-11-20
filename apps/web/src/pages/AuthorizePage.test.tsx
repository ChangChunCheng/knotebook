import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import type { OauthRequestDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import { expectCardControls44 } from "@/test/card-controls";

// Same convention as ChangePasswordPage.test.tsx: mock global fetch and go through the real AppRoutes - what is verified is that the route
// is wired correctly (mounted under RequireAuth), not just the component rendered alone.

const USER: UserDto = {
  id: "u1",
  email: "alice@example.com",
  handle: "alice",
  displayName: "Alice",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

const REQUEST: OauthRequestDto = {
  clientName: "Claude Code",
  redirectHost: "127.0.0.1:5678",
  scope: "notes:read notes:write",
  scopes: ["notes:read", "notes:write"],
  replacesExisting: false,
  existingScope: null,
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="app-location">{`${location.pathname}${location.search}`}</div>;
}

// Deliberately NOT setting `retry: false` in the harness: the 410/404 cases guard the hook's own `retry: false` - overriding it here
// would keep the suite green even with that line removed (production would retry three more times before showing the error).
// The guard is counting: when the error screen appears, `/api/oauth/request` has been called exactly once (with three retries the error
// appears only after the fourth failure, i.e. 4 calls). It does not rely on a wait limit: react-query's default backoff of 1+2+4 = ~7 s
// fits within the global asyncUtilTimeout, so "how long until it appears" cannot guard it.
function renderAt(path: string, me: () => Response = () => okMe()) {
  const client = new QueryClient();
  meHandler = me;
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
          <LocationProbe />
        </MemoryRouter>
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

type Handler = () => Response | Promise<Response>;

const okMe = (): Response => ({ ok: true, status: 200, json: async () => USER }) as unknown as Response;
let meHandler: () => Response = okMe;

function mockFetch(requestHandler: Handler, decisionHandler?: Handler) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/groups") return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    if (url.startsWith("/api/auth/me")) return meHandler();
    if (url.startsWith("/api/auth/config"))
      return { ok: true, status: 200, json: async () => ({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true } }) } as unknown as Response;
    if (url.startsWith("/api/oauth/request")) return requestHandler();
    if (url.startsWith("/api/oauth/decision")) {
      expect(init?.method).toBe("POST");
      return decisionHandler!();
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const okRequest = (): Response => ({ ok: true, status: 200, json: async () => REQUEST }) as unknown as Response;
const errorResponse = (status: number, code: string): Response =>
  ({ ok: false, status, json: async () => ({ error: { code, message: code } }) }) as unknown as Response;
const redirectResponse = (redirectTo: string): Response =>
  ({ ok: true, status: 200, json: async () => ({ redirectTo }) }) as unknown as Response;

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  meHandler = okMe;
  // Toast cleanup between cases is done by the global afterEach in test/setup.ts (the "decision returns 410" toast and the in-page text of
  // "410 -> error page" are the same string, and without clearing, the latter would find the previous case's toast and pass falsely).
});

describe("AuthorizePage", () => {
  it("shows the name, redirect host, plain-language scope, signed-in identity and the loopback warning", async () => {
    vi.stubGlobal("fetch", mockFetch(okRequest));
    renderAt("/authorize?req=abc");

    // The name and the suffix are two nodes (needed for bidi isolation), and testing-library's getNodeText only joins direct child
    // text nodes, so no node contains both: assert them separately.
    // The name node's textContent must be exactly the name (regex anchored): if the suffix were merged into the same isolate span, a
    // substring match would still pass, but U+202E could reverse the suffix along with it.
    expect(await screen.findByTestId("authorize-client-name")).toHaveTextContent(/^Claude Code$/);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Claude Code wants to access your Knotebook");
    expect(screen.getByText(/self-reported/)).toBeInTheDocument();
    expect(screen.getByText(/127\.0\.0\.1:5678/)).toBeInTheDocument();
    expect(screen.getByText("Read all of your notes")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Create and edit notes" })).toBeInTheDocument();
    expect(screen.getByText(/Signed in as alice/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not you? Sign out" })).toBeInTheDocument();
    expect(screen.getByText(/Only allow this if a program you just started/)).toBeInTheDocument();
    expect(screen.queryByText(/replace the previous authorization/)).not.toBeInTheDocument();
  });

  it("card page exception: Allow and Deny are 44px (h-11); the checkbox and the \"Not you?\" text button are not enlarged", async () => {
    vi.stubGlobal("fetch", mockFetch(okRequest));
    renderAt("/authorize?req=abc");
    await screen.findByRole("button", { name: "Allow" });
    expect(expectCardControls44(undefined, "button.underline")).toBe(2);
  });

  // Which layer the route sits under must be guarded: one case covers moving it out of RequireAuth, the other out of ChangePasswordGate.
  it("not signed in -> /login?next=%2Fauthorize%3Freq%3Dabc (query included, so #131 can return)", async () => {
    vi.stubGlobal("fetch", mockFetch(okRequest));
    renderAt("/authorize?req=abc", () => errorResponse(401, "unauthorized"));
    await waitFor(() => {
      expect(screen.getByTestId("app-location").textContent).toBe("/login?next=%2Fauthorize%3Freq%3Dabc");
    });
  });

  it("mustChangePassword -> goes to /change-password first, the consent page is not visible", async () => {
    vi.stubGlobal("fetch", mockFetch(okRequest));
    renderAt(
      "/authorize?req=abc",
      () => ({ ok: true, status: 200, json: async () => ({ ...USER, mustChangePassword: true }) }) as unknown as Response
    );
    await waitFor(() => {
      expect(screen.getByTestId("app-location").textContent).toBe("/change-password");
    });
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
  });

  it("client name is rendered with dir=ltr and a bidi isolate", async () => {
    vi.stubGlobal("fetch", mockFetch(okRequest));
    renderAt("/authorize?req=abc");
    const name = await screen.findByTestId("authorize-client-name");
    expect(name).toHaveAttribute("dir", "ltr");
    expect(name.className).toContain("unicode-bidi:isolate");
  });

  it("replacesExisting adds a line about replacing; a read-only scope lists a single entry", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({
              ...REQUEST,
              scope: "notes:read",
              scopes: ["notes:read"],
              replacesExisting: true,
              existingScope: "notes:read notes:write",
            }),
          }) as unknown as Response
      )
    );
    renderAt("/authorize?req=abc");
    expect(await screen.findByText(/replace the previous authorization/)).toBeInTheDocument();
    expect(screen.getByText("Read all of your notes")).toBeInTheDocument();
    expect(screen.queryByText("Create and edit notes")).not.toBeInTheDocument();
  });

  it("Allow -> POST decision with allow + the checked scopes, then navigates to redirectTo", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = mockFetch(okRequest, () => redirectResponse("http://127.0.0.1:5678/cb?code=x"));
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize?req=abc");

    fireEvent.click(await screen.findByRole("checkbox", { name: "Create and edit notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://127.0.0.1:5678/cb?code=x"));
    const decisionCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith("/api/oauth/decision"))!;
    expect(JSON.parse(decisionCall[1]!.body as string)).toEqual({
      req: "abc",
      decision: "allow",
      scope: "notes:read notes:write",
    });
  });

  it("Deny -> POST decision with deny, then navigates", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = mockFetch(okRequest, () => redirectResponse("http://127.0.0.1:5678/cb?error=access_denied"));
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize?req=abc");

    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://127.0.0.1:5678/cb?error=access_denied"));
    const decisionCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith("/api/oauth/decision"))!;
    expect(JSON.parse(decisionCall[1]!.body as string)).toEqual({ req: "abc", decision: "deny" });
  });

  it("decision returns 409 token_limit -> toast saying to revoke first and start again from the application; no navigation", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    vi.stubGlobal("fetch", mockFetch(okRequest, () => errorResponse(409, "token_limit")));
    renderAt("/authorize?req=abc");

    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    // A dedicated fragment: `denyHint` also contains "start again from the application", so asserting on it would match
    // the text that is always present instead of the toast.
    expect(await screen.findByText(/Token limit reached/)).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load this authorization request/)).not.toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it("decision returns 410 -> 'already used or expired' toast (not the generic load-failure text)", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    vi.stubGlobal("fetch", mockFetch(okRequest, () => errorResponse(410, "oauth_request_invalid")));
    renderAt("/authorize?req=abc");

    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByText(/already been used or has expired/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it("after a successful submit both buttons are locked (the window while the navigation is still in flight)", async () => {
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    vi.stubGlobal("fetch", mockFetch(okRequest, () => redirectResponse("http://127.0.0.1:5678/cb?code=x")));
    renderAt("/authorize?req=abc");

    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
  });

  it("missing req -> shows an error and no buttons, and does not call the request endpoint", async () => {
    const fetchMock = mockFetch(() => {
      throw new Error("should not fetch request");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize");
    expect(await screen.findByText(/missing the authorization request id/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/oauth/request"))).toBe(false);
  });

  it("`?req=` (empty string) counts as missing: the endpoint is not called", async () => {
    const fetchMock = mockFetch(() => {
      throw new Error("should not fetch request");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize?req=");
    expect(await screen.findByText(/missing the authorization request id/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/oauth/request"))).toBe(false);
  });

  it("410 -> shows 'start again from the application' and no buttons; no retry (called exactly once)", async () => {
    const fetchMock = mockFetch(() => errorResponse(410, "oauth_request_invalid"));
    vi.stubGlobal("fetch", fetchMock);
    const requestCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/oauth/request")).length;
    renderAt("/authorize?req=abc");
    expect(await screen.findByText(/already been used or has expired/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
    // Guard for the hook's `retry: false` (see the comment above renderAt): with retries the error would show only after 4 calls.
    expect(requestCalls()).toBe(1);
  });

  it("404 -> generic error and no buttons; no retry (called exactly once)", async () => {
    const fetchMock = mockFetch(() => errorResponse(404, "not_found"));
    vi.stubGlobal("fetch", fetchMock);
    const requestCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/oauth/request")).length;
    renderAt("/authorize?req=abc");
    expect(await screen.findByText(/Couldn't load this authorization request/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
    expect(requestCalls()).toBe(1);
  });
});

// #239: per-item checkboxes, default checks, linkage, and the hint that the grant is narrower than the existing one.
describe("AuthorizePage #239 per-item checkboxes", () => {
  const RWM = "notes:read notes:write notes:move" as const;
  const RW = "notes:read notes:write" as const;
  const EDIT = "Create and edit notes";
  const MOVE = "Move to groups (can't be undone)";
  const requestWith = (patch: Partial<OauthRequestDto>) => (): Response =>
    ({ ok: true, status: 200, json: async () => ({ ...REQUEST, ...patch }) }) as unknown as Response;
  const THREE = { scope: RWM, scopes: ["notes:read", "notes:write", "notes:move"] };
  async function decisionBody(fetchMock: ReturnType<typeof mockFetch>): Promise<unknown> {
    const isDecision = ([url]: [RequestInfo | URL, RequestInit?]) => String(url).startsWith("/api/oauth/decision");
    await waitFor(() => expect(fetchMock.mock.calls.some(isDecision)).toBe(true));
    return JSON.parse(fetchMock.mock.calls.find(isDecision)![1]!.body as string);
  }

  it("first authorization (existingScope null), three items requested -> title is scopesTitleChoose, both boxes unchecked", async () => {
    vi.stubGlobal("fetch", mockFetch(requestWith({ ...THREE, existingScope: null, replacesExisting: false })));
    renderAt("/authorize?req=abc");
    expect(await screen.findByText(i18n.t("authorize.scopesTitleChoose"))).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: EDIT })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: MOVE })).not.toBeChecked();
    expect(screen.queryByText(i18n.t("authorize.scopesTitle"))).not.toBeInTheDocument();
    expect(screen.queryByText("Currently granted")).not.toBeInTheDocument();
  });

  it("a11y: both boxes are in a group named by the title; the move box carries the consequence text via aria-describedby", async () => {
    vi.stubGlobal("fetch", mockFetch(requestWith({ ...THREE, existingScope: null, replacesExisting: false })));
    renderAt("/authorize?req=abc");
    const group = await screen.findByRole("group", { name: i18n.t("authorize.scopesTitleChoose") });
    expect(within(group).getByRole("checkbox", { name: EDIT })).toBeInTheDocument();
    expect(within(group).getByRole("checkbox", { name: MOVE })).toHaveAccessibleDescription(
      i18n.t("settings.account.apiTokensScopeMoveHint")
    );
  });

  it("existing read-write, three items requested -> edit checked by default, move unchecked, \"Currently granted\" appears once and on the edit row", async () => {
    vi.stubGlobal("fetch", mockFetch(requestWith({ ...THREE, existingScope: RW, replacesExisting: true })));
    renderAt("/authorize?req=abc");
    const edit = await screen.findByRole("checkbox", { name: EDIT });
    expect(edit).toBeChecked();
    expect(screen.getByRole("checkbox", { name: MOVE })).not.toBeChecked();
    const granted = screen.getAllByText("Currently granted");
    expect(granted).toHaveLength(1);
    expect(granted[0]!.parentElement).toContainElement(edit);
    expect(screen.queryByText(i18n.t("authorize.replacesWithLess"))).not.toBeInTheDocument();
  });

  it("existing read-write-move, only read-write requested -> edit checked, no move box, replacesWithLess shown; Allow sends read-write (not more than requested)", async () => {
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    const fetchMock = mockFetch(
      requestWith({ scope: RW, scopes: ["notes:read", "notes:write"], existingScope: RWM, replacesExisting: true }),
      () => redirectResponse("http://127.0.0.1:5678/cb?code=x")
    );
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize?req=abc");
    expect(await screen.findByRole("checkbox", { name: EDIT })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: MOVE })).toBeNull();
    expect(screen.getByText(i18n.t("authorize.replacesWithLess"))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("authorize.replacesWithLessReadOnly"))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await decisionBody(fetchMock)).toEqual({ req: "abc", decision: "allow", scope: RW });
  });

  it("check edit -> check move -> uncheck edit -> move is disabled and cleared; Allow sends notes:read", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = mockFetch(
      requestWith({ ...THREE, existingScope: null, replacesExisting: false }),
      () => redirectResponse("http://127.0.0.1:5678/cb?code=x")
    );
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize?req=abc");
    const edit = await screen.findByRole("checkbox", { name: EDIT });
    const move = screen.getByRole("checkbox", { name: MOVE });
    expect(move).toBeDisabled(); // move cannot be selected while edit is unchecked
    fireEvent.click(edit);
    expect(move).toBeEnabled();
    fireEvent.click(move);
    expect(move).toBeChecked();
    fireEvent.click(edit);
    expect(move).toBeDisabled();
    expect(move).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const decisionCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith("/api/oauth/decision"))!;
    expect(JSON.parse(decisionCall[1]!.body as string)).toEqual({ req: "abc", decision: "allow", scope: "notes:read" });
  });

  it("checking both boxes -> Allow sends the third scope form", async () => {
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    const fetchMock = mockFetch(
      requestWith({ ...THREE, existingScope: null, replacesExisting: false }),
      () => redirectResponse("http://127.0.0.1:5678/cb?code=x")
    );
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize?req=abc");
    fireEvent.click(await screen.findByRole("checkbox", { name: EDIT }));
    fireEvent.click(screen.getByRole("checkbox", { name: MOVE }));
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/oauth/decision"))).toBe(true)
    );
    const decisionCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith("/api/oauth/decision"))!;
    expect(JSON.parse(decisionCall[1]!.body as string)).toEqual({ req: "abc", decision: "allow", scope: RWM });
  });

  it("existing read-write, only read-only requested -> no checkboxes, replacesWithLessReadOnly shown, title is scopesTitle; Allow sends read-only", async () => {
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    const fetchMock = mockFetch(
      requestWith({ scope: "notes:read", scopes: ["notes:read"], existingScope: RW, replacesExisting: true }),
      () => redirectResponse("http://127.0.0.1:5678/cb?code=x")
    );
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize?req=abc");
    expect(await screen.findByText(i18n.t("authorize.replacesWithLessReadOnly"))).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText(i18n.t("authorize.scopesTitle"))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("authorize.scopesTitleChoose"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("authorize.replacesWithLess"))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await decisionBody(fetchMock)).toEqual({ req: "abc", decision: "allow", scope: "notes:read" });
  });

  it("window refocus / reconnect does not refetch the request (the initial checks and the \"Currently granted\" marker come from the same snapshot)", async () => {
    const fetchMock = mockFetch(requestWith({ ...THREE, existingScope: RW, replacesExisting: true }));
    vi.stubGlobal("fetch", fetchMock);
    const requestCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/oauth/request")).length;
    renderAt("/authorize?req=abc");
    await screen.findByRole("checkbox", { name: EDIT });
    expect(requestCalls()).toBe(1);
    try {
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        onlineManager.setOnline(false);
        onlineManager.setOnline(true);
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(requestCalls()).toBe(1);
    } finally {
      focusManager.setFocused(undefined);
      onlineManager.setOnline(true);
    }
  });

  it("an unknown scope is not rendered as \"Read all of your notes\"", async () => {
    vi.stubGlobal("fetch", mockFetch(requestWith({ scope: "notes:read", scopes: ["notes:read", "notes:admin"] })));
    renderAt("/authorize?req=abc");
    expect(await screen.findAllByText("Read all of your notes")).toHaveLength(1);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});

// #181: third box "delete": not rendered when the client did not request it, unchecked by default, cleared together when edit is unchecked, intersected with the existing grant.
describe("AuthorizePage #181 delete checkbox", () => {
  const R = "notes:read" as const;
  const RW = "notes:read notes:write" as const;
  const RWM = "notes:read notes:write notes:move" as const;
  const RWD = "notes:read notes:write notes:delete" as const;
  const RWMD = "notes:read notes:write notes:move notes:delete" as const;
  const EDIT = "Create and edit notes";
  const MOVE = "Move to groups (can't be undone)";
  const DELETE = "Move to trash (can be restored)";
  // The delete box's persistent description = the basic description + the sentence "requires edit to be checked too" (same ending as the move description). Pinned verbatim in both locales.
  const DELETE_HINT_EN =
    "Can't delete notes permanently, but notes left in the trash can still be deleted permanently later, by the site's trash setting or by someone in the web app. Requires \"Create and edit notes\".";
  const DELETE_HINT_ZH =
    "不能永久刪除筆記；但留在垃圾桶的筆記之後仍可能被永久刪除（依站台的垃圾桶設定，或有人在網頁上刪除）。需同時勾選「建立與修改筆記」。";
  const ASK_RWM = { scope: RWM, scopes: ["notes:read", "notes:write", "notes:move"] };
  const ASK_ALL = { scope: RWMD, scopes: ["notes:read", "notes:write", "notes:move", "notes:delete"] };
  const requestWith = (patch: Partial<OauthRequestDto>) => (): Response =>
    ({ ok: true, status: 200, json: async () => ({ ...REQUEST, ...patch }) }) as unknown as Response;
  function setup(patch: Partial<OauthRequestDto>) {
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    const fetchMock = mockFetch(requestWith(patch), () => redirectResponse("http://127.0.0.1:5678/cb?code=x"));
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize?req=abc");
    return fetchMock;
  }
  async function decisionBody(fetchMock: ReturnType<typeof mockFetch>): Promise<unknown> {
    const isDecision = ([url]: [RequestInfo | URL, RequestInit?]) => String(url).startsWith("/api/oauth/decision");
    await waitFor(() => expect(fetchMock.mock.calls.some(isDecision)).toBe(true));
    return JSON.parse(fetchMock.mock.calls.find(isDecision)![1]!.body as string);
  }

  it("client did not request notes:delete -> no delete checkbox", async () => {
    setup({ ...ASK_RWM, existingScope: null });
    expect(await screen.findByRole("checkbox", { name: EDIT })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: MOVE })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: DELETE })).toBeNull();
  });

  it("four items requested, first authorization -> three boxes unchecked; delete is disabled until edit is checked and carries the consequence text; checking edit + delete -> Allow sends RWD", async () => {
    const fetchMock = setup({ ...ASK_ALL, existingScope: null });
    const edit = await screen.findByRole("checkbox", { name: EDIT });
    const move = screen.getByRole("checkbox", { name: MOVE });
    const del = screen.getByRole("checkbox", { name: DELETE });
    expect(edit).not.toBeChecked();
    expect(move).not.toBeChecked();
    expect(del).not.toBeChecked();
    expect(del).toBeDisabled();
    expect(del).toHaveAccessibleDescription(DELETE_HINT_EN);
    fireEvent.click(edit);
    expect(del).toBeEnabled();
    fireEvent.click(del);
    expect(del).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await decisionBody(fetchMock)).toEqual({ req: "abc", decision: "allow", scope: RWD });
  });

  it("existing RWD, RWM requested -> only edit checked, no delete box, replacesWithLess shown; Allow sends RW", async () => {
    const fetchMock = setup({ ...ASK_RWM, existingScope: RWD, replacesExisting: true });
    expect(await screen.findByRole("checkbox", { name: EDIT })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: MOVE })).not.toBeChecked();
    expect(screen.queryByRole("checkbox", { name: DELETE })).toBeNull();
    expect(screen.getByText(i18n.t("authorize.replacesWithLess"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await decisionBody(fetchMock)).toEqual({ req: "abc", decision: "allow", scope: RW });
  });

  it("existing RWMD, four items requested -> all three boxes checked, three \"Currently granted\" markers, no replacesWithLess", async () => {
    setup({ ...ASK_ALL, existingScope: RWMD, replacesExisting: true });
    const del = await screen.findByRole("checkbox", { name: DELETE });
    expect(screen.getByRole("checkbox", { name: EDIT })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: MOVE })).toBeChecked();
    expect(del).toBeChecked();
    const granted = screen.getAllByText("Currently granted");
    expect(granted).toHaveLength(3);
    expect(granted.some(g => g.parentElement!.contains(del))).toBe(true);
    expect(screen.queryByText(i18n.t("authorize.replacesWithLess"))).not.toBeInTheDocument();
  });

  it("after checking all three boxes, unchecking edit -> move and delete are cleared and disabled; Allow sends R", async () => {
    const fetchMock = setup({ ...ASK_ALL, existingScope: null });
    const edit = await screen.findByRole("checkbox", { name: EDIT });
    const move = screen.getByRole("checkbox", { name: MOVE });
    const del = screen.getByRole("checkbox", { name: DELETE });
    fireEvent.click(edit);
    fireEvent.click(move);
    fireEvent.click(del);
    expect(move).toBeChecked();
    expect(del).toBeChecked();
    fireEvent.click(edit);
    expect(move).not.toBeChecked();
    expect(move).toBeDisabled();
    expect(del).not.toBeChecked();
    expect(del).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await decisionBody(fetchMock)).toEqual({ req: "abc", decision: "allow", scope: R });
  });

  it("existing RWM, RWD requested (not comparable per box) -> only edit checked, delete unchecked, \"Currently granted\" only on the edit row, replacesWithLess shown; checking delete -> Allow sends RWD", async () => {
    const fetchMock = setup({ scope: RWD, scopes: ["notes:read", "notes:write", "notes:delete"], existingScope: RWM, replacesExisting: true });
    const del = await screen.findByRole("checkbox", { name: DELETE });
    expect(screen.getByRole("checkbox", { name: EDIT })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: MOVE })).toBeNull();
    expect(del).not.toBeChecked();
    expect(screen.getAllByText("Currently granted")).toHaveLength(1);
    expect(screen.getByText(i18n.t("authorize.replacesWithLess"))).toBeInTheDocument();
    fireEvent.click(del);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await decisionBody(fetchMock)).toEqual({ req: "abc", decision: "allow", scope: RWD });
  });

  it("(zh-TW) the delete box's persistent description ends with 「需同時勾選「建立與修改筆記」。」 and is the box's accessible description", async () => {
    await i18n.changeLanguage("zh-TW");
    setup({ ...ASK_ALL, existingScope: null });
    const del = await screen.findByRole("checkbox", { name: "移到垃圾桶（可還原）" });
    expect(del).toBeDisabled();
    expect(del).toHaveAccessibleDescription(DELETE_HINT_ZH);
  });
});
