import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { AppRoutes } from "@/App";
import ResetPasswordPage from "./ResetPasswordPage";
import { expectCardControls44 } from "@/test/card-controls";

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: body === undefined ? () => Promise.reject(new Error("no body")) : () => Promise.resolve(body) } as unknown as Response;
}
const fail = (status: number, code: string) => fakeResponse(status, { error: { code, message: "x" } });

/** Same solid-button class as `SOLID_BG` in `RegisterPage.test.tsx`. */
const SOLID_BG = /(^|\s)bg-(primary|destructive|brand|brand-deep)(\s|$)/;
const KEY = "knotebook:reset-token";
const TOKEN = "knbp_X";
const EXPIRES_AT = "2030-01-02T03:04:00.000Z";
const WHEN = new Date(EXPIRES_AT).toLocaleString("en", { dateStyle: "short", timeStyle: "short" });
const NEW_PASSWORD = "correct-horse-battery";
const ME: UserDto = { id: "u-me", email: "me@example.com", handle: "me", displayName: "Me", isAdmin: true, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null };
const RESET_USER: UserDto = { id: "u-a", email: "a@example.com", handle: "a", displayName: "A", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null };

const INVALID_TEXT = "This password reset link is invalid, already used, or expired. Ask the site administrator for a new one.";
const NOTICE_TEXT = "Setting it signs you out of every other browser. API tokens and connected apps keep working.";
const LOGIN_OFF_TEXT = "Password sign-in is turned off on this site right now, so this link can't be used. Ask the site administrator.";
const SIGNED_IN_TEXT = "You're signed in as me@example.com. Sign out to use this link.";
const TOO_MANY_TEXT = "Too many requests. Please slow down.";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</div>;
}

let navigateFn: ((to: string) => void) | null = null;
function NavigateHandle() {
  const navigate = useNavigate();
  navigateFn = navigate;
  return null;
}

function Elsewhere() {
  return <p>elsewhere</p>;
}

interface Handlers {
  me?: () => Response;
  inspect?: () => Response;
  complete?: () => Response | Promise<Response>;
}

function stubFetch(handlers: Handlers) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (url === "/api/auth/me") return (handlers.me ?? (() => fail(401, "unauthorized")))();
      if (url === "/api/auth/password-reset/inspect" && method === "POST") {
        return (handlers.inspect ?? (() => fakeResponse(200, { email: RESET_USER.email, expiresAt: EXPIRES_AT })))();
      }
      if (url === "/api/auth/password-reset" && method === "POST") return (handlers.complete ?? (() => fakeResponse(200, RESET_USER)))();
      if (url === "/api/auth/logout" && method === "POST") return fakeResponse(204);
      return fail(404, "not_found");
    }),
  );
  return calls;
}

function setup(path: string, handlers: Handlers = {}) {
  const calls = stubFetch(handlers);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="*" element={<Elsewhere />} />
        </Routes>
        <LocationProbe />
        <NavigateHandle />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls, queryClient };
}

type Call = { url: string; method: string; body: unknown };
const inspectCalls = (calls: Call[]) => calls.filter((c) => c.url === "/api/auth/password-reset/inspect");
const completeCalls = (calls: Call[]) => calls.filter((c) => c.url === "/api/auth/password-reset");
const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

async function submit(password: string, confirm: string) {
  fireEvent.change(await screen.findByLabelText("New password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: confirm } });
  fireEvent.click(screen.getByRole("button", { name: "Set password" }));
}

describe("ResetPasswordPage (#286)", () => {
  beforeEach(async () => {
    sessionStorage.clear();
    navigateFn = null;
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("fragment with token: router hash cleared, key stored, inspect uses the token, shows account and expiry, notice, two password fields", async () => {
    const { calls } = setup(`/reset-password#token=${TOKEN}`);
    expect(await screen.findByText(`For a@example.com. This link works once and expires ${WHEN}.`)).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/reset-password$/);
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
    expect(inspectCalls(calls)).toHaveLength(1);
    expect(inspectCalls(calls)[0]!.body).toEqual({ token: TOKEN });
    expect(screen.getByRole("heading", { name: "Set a new password" })).toBeInTheDocument();
    expect(screen.getByText(NOTICE_TEXT)).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("Confirm new password")).toHaveAttribute("type", "password");
  });

  it("card-page exception: Set password button is lg (h-11) and both password fields are also h-11 (equal height per column)", async () => {
    setup(`/reset-password#token=${TOKEN}`);
    await screen.findByLabelText("New password");
    const targets = [
      screen.getByRole("button", { name: "Set password" }),
      screen.getByLabelText("New password"),
      screen.getByLabelText("Confirm new password"),
    ];
    for (const el of targets) {
      expect(el).toHaveClass("h-11");
      expect(el).not.toHaveClass("h-8");
    }
  });

  it("reload (no fragment, key still stored) -> inspect uses the stored token, form appears", async () => {
    sessionStorage.setItem(KEY, TOKEN);
    const { calls } = setup("/reset-password");
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(inspectCalls(calls)[0]!.body).toEqual({ token: TOKEN });
  });

  it("no fragment and no key -> full invalid text plus back-to-login link, no inspect call", async () => {
    const { calls } = setup("/reset-password");
    expect(await screen.findByText(INVALID_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Set a new password" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/login");
    await tick();
    expect(inspectCalls(calls)).toHaveLength(0);
  });

  it("empty `#token=` -> fragment still cleared, full invalid text, no inspect call", async () => {
    const { calls } = setup("/reset-password#token=");
    expect(await screen.findByText(INVALID_TEXT)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/reset-password$/));
    await tick();
    expect(inspectCalls(calls)).toHaveLength(0);
  });

  it("inspect 410 -> full invalid text, key removed", async () => {
    setup(`/reset-password#token=${TOKEN}`, { inspect: () => fail(410, "reset_link_invalid") });
    expect(await screen.findByText(INVALID_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/login");
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("inspect 403 password_login_disabled -> full passwordLoginOff text, no form, key kept", async () => {
    setup(`/reset-password#token=${TOKEN}`, { inspect: () => fail(403, "password_login_disabled") });
    expect(await screen.findByText(LOGIN_OFF_TEXT)).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
  });

  it("signed in: shows only signedIn plus Sign out, no inspect, no key written, hash cleared; after sign-out the form appears and the key is written", async () => {
    let me = () => fakeResponse(200, ME);
    const { calls } = setup(`/reset-password#token=${TOKEN}`, { me: () => me() });
    expect(await screen.findByText(SIGNED_IN_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Set a new password" })).toBeInTheDocument();
    const signOut = screen.getByRole("button", { name: "Sign out" });
    expect(expectCardControls44()).toBeGreaterThan(0);
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/reset-password$/);
    await tick();
    expect(inspectCalls(calls)).toHaveLength(0);
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(screen.queryByLabelText("New password")).toBeNull();

    me = () => fail(401, "unauthorized");
    fireEvent.click(signOut);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/auth/logout" && c.method === "POST")).toBe(true));
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(inspectCalls(calls)[0]!.body).toEqual({ token: TOKEN });
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/reset-password$/);
  });

  it("too short -> errors.password_too_short, not sent; mismatch -> register.mismatch, not sent", async () => {
    const { calls } = setup(`/reset-password#token=${TOKEN}`);
    await submit("short", "short");
    expect(await screen.findByRole("alert")).toHaveTextContent("Password is too short.");
    await submit(NEW_PASSWORD, `${NEW_PASSWORD}-x`);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The passwords don't match."));
    await tick();
    expect(completeCalls(calls)).toHaveLength(0);
  });

  it("success: complete request body is correct -> navigates to /, session cache gets the response; key is already removed before the cache write", async () => {
    const { calls, queryClient } = setup(`/reset-password#token=${TOKEN}`);
    // The key is always deleted eventually (signed-in effect, unmount cleanup), so check whether it is still there at the moment of the session-cache write:
    // if the success path doesn't delete it itself, it still is. This pins the order "delete key, then setQueryData"; the order is not a requirement: reordering the two turns this red and the test should follow.
    const keyAtSessionWrite: Array<string | null> = [];
    const setQueryData = queryClient.setQueryData.bind(queryClient);
    vi.spyOn(queryClient, "setQueryData").mockImplementation(((key: unknown, data: unknown) => {
      keyAtSessionWrite.push(sessionStorage.getItem(KEY));
      return setQueryData(key as never, data as never);
    }) as never);
    await submit(NEW_PASSWORD, NEW_PASSWORD);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(completeCalls(calls)[0]!.body).toEqual({ token: TOKEN, newPassword: NEW_PASSWORD });
    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toEqual(RESET_USER);
    expect(keyAtSessionWrite).toEqual([null]);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("complete returns 429 -> alert above the form, key kept; resubmit returning 410 -> full invalid text, key removed", async () => {
    let complete = () => fail(429, "too_many_requests");
    setup(`/reset-password#token=${TOKEN}`, { complete: () => complete() });
    await submit(NEW_PASSWORD, NEW_PASSWORD);
    expect(await screen.findByRole("alert")).toHaveTextContent(TOO_MANY_TEXT);
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);

    complete = () => fail(410, "reset_link_invalid");
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByText(INVALID_TEXT)).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("SPA navigation away after the form appears -> key removed", async () => {
    setup(`/reset-password#token=${TOKEN}`);
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
    act(() => navigateFn?.("/login"));
    expect(await screen.findByText("elsewhere")).toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("route placement: opening unauthenticated under AppRoutes -> reset page title appears, no redirect to /login", async () => {
    stubFetch({});
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[`/reset-password#token=${TOKEN}`]}>
            <AppRoutes />
            <LocationProbe />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Set a new password" })).toBeInTheDocument();
    // The title shows in every state: also wait for the form, to be sure inspect finished and there was no redirect to /login.
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    // The effect that clears the fragment (navigate replace) only takes effect after the form renders (visible on slow CI), so wait instead of asserting immediately.
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/reset-password$/));
  });

  it("form screen has exactly one solid button (Set password)", async () => {
    setup(`/reset-password#token=${TOKEN}`);
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    const solid = [...screen.getAllByRole("button"), ...screen.queryAllByRole("link")].filter((el) => SOLID_BG.test(el.className));
    expect(solid.map((el) => el.textContent)).toEqual(["Set password"]);
  });

  it("/me returns 500 -> sessionError plus Try again, no inspect; retry returning 401 -> form appears", async () => {
    let me = () => fail(500, "internal");
    const { calls } = setup(`/reset-password#token=${TOKEN}`, { me: () => me() });
    expect(await screen.findByText("Couldn't load your session.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Set a new password" })).toBeInTheDocument();
    expect(expectCardControls44()).toBeGreaterThan(0);
    expect(inspectCalls(calls)).toHaveLength(0);
    me = () => fail(401, "unauthorized");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(inspectCalls(calls)).toHaveLength(1);
  });

  it("inspect 429 -> full too_many_requests text, no form, key kept", async () => {
    setup(`/reset-password#token=${TOKEN}`, { inspect: () => fail(429, "too_many_requests") });
    expect(await screen.findByText(TOO_MANY_TEXT)).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(screen.queryByText(INVALID_TEXT)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
  });

  it("same page switches to a new token (A returns 410, then #token=B is pasted): B is inspected, form appears, key is B, hash cleared", async () => {
    let n = 0;
    const { calls } = setup(`/reset-password#token=${TOKEN}`, {
      inspect: () => (++n === 1 ? fail(410, "reset_link_invalid") : fakeResponse(200, { email: RESET_USER.email, expiresAt: EXPIRES_AT })),
    });
    expect(await screen.findByText(INVALID_TEXT)).toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    act(() => navigateFn!("/reset-password#token=knbp_B"));
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(inspectCalls(calls).map((c) => c.body)).toEqual([{ token: TOKEN }, { token: "knbp_B" }]);
    expect(screen.queryByText(INVALID_TEXT)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBe("knbp_B");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/reset-password$/));
  });

  it("A's form has an error and input -> same page switches to B: no old error, fields cleared", async () => {
    setup(`/reset-password#token=${TOKEN}`);
    await submit("short", "short");
    expect(await screen.findByRole("alert")).toHaveTextContent("Password is too short.");
    act(() => navigateFn!("/reset-password#token=knbp_B"));
    await waitFor(() => expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe(""));
    expect((screen.getByLabelText("Confirm new password") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("A submitting -> switch to B -> A's late 410: B's form remains, not stuck on checking, key is still B", async () => {
    let resolveComplete: (r: Response) => void = () => {};
    setup(`/reset-password#token=${TOKEN}`, { complete: () => new Promise<Response>((resolve) => (resolveComplete = resolve)) });
    await submit(NEW_PASSWORD, NEW_PASSWORD);
    await waitFor(() => expect(screen.getByRole("button", { name: "Saving…" })).toBeInTheDocument());
    act(() => navigateFn!("/reset-password#token=knbp_B"));
    await waitFor(() => expect(sessionStorage.getItem(KEY)).toBe("knbp_B"));
    expect(await screen.findByRole("button", { name: "Set password" })).toBeInTheDocument();
    await act(async () => {
      resolveComplete(fail(410, "reset_link_invalid"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.queryByText(INVALID_TEXT)).toBeNull();
    expect(screen.queryByText("Checking the link…")).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBe("knbp_B");
  });
});
