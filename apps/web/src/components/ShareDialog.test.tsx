import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { avatarUrl, type NoteDto, type NoteWidth, type ShareDto, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { clickOutside } from "@/test/outside-click";
import { chooseOption, optionLabels, selectedValue } from "@/test/ui-select";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { EDITOR_PERMS, OWNER_PERMS, VIEWER_PERMS } from "@/test/fixtures";
import { ShareDialog } from "./ShareDialog";

// Mock global fetch so the real share hooks (react-query) hit fake responses instead of mocking the hooks (see NoteList.test.tsx/TitleInput.test.tsx).

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "My Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  groupId: null,
  group: null,
  folderId: null,
  permissions: { ...OWNER_PERMS },
};

const SHARE: ShareDto = {
  userId: "22222222-2222-2222-2222-222222222222",
  email: "bob@example.com",
  displayName: "Bob",
  role: "viewer",
  avatar: null,
};

const SHARES_URL = `/api/notes/${NOTE.id}/shares`;

function renderDialog(note: NoteDto = NOTE) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // A new element every time: with the same element identity React bails out and never re-renders, so "what happens on re-render" couldn't be tested.
  const tree = (current: NoteDto) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/notes/${current.id}`]}>
        <ShareDialog note={current} />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree(note));
  return Object.assign(queryClient, { rerender: (next: NoteDto = note) => view.rerender(tree(next)) });
}

async function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  // The 'restricted members' panel only mounts when selection==="members", so it can't signal that the dialog opened; "Access" is the ShareGroup title, rendered unconditionally in all three states.
  await waitFor(() => expect(screen.getByText("Access")).toBeInTheDocument());
}

/** Switches to 'restricted members' so the panel under it appears. The radio is only clickable after the latch completes (`disabled={!latched || busy}`), so wait for it to be enabled first. */
async function selectMembers() {
  const radio = await screen.findByRole("radio", { name: /Members only/ });
  await waitFor(() => expect(radio).not.toBeDisabled());
  fireEvent.click(radio);
}

describe("ShareDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.history.replaceState(null, "", `/notes/${NOTE.id}`);
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("non-owner (editor/viewer) doesn't render the share button or dialog", () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("should not fetch")));
    vi.stubGlobal("fetch", fetchMock);

    renderDialog({ ...NOTE, role: "editor", permissions: { ...EDITOR_PERMS } });

    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("owner sees the share button, clicking it renders the dialog", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) })),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share" })).toHaveClass("text-brand", "hover:text-brand");

    await openDialog();
    expect(screen.getByRole("heading", { name: "Share note" })).toBeInTheDocument();
  });

  it("clicking outside the dialog doesn't close it and the filled email stays (form-style guard)", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === PUBLIC_LINK_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null, slug: null }) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();
    await openDialog();
    await selectMembers();
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "keep@example.com" } });
    await clickOutside();
    expect(screen.getByRole("heading", { name: "Share note" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toHaveValue("keep@example.com");
  });

  it("adding a share sends PUT {email, role}", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === PUBLIC_LINK_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null, slug: null }) }));
      }
      if (url === SHARES_URL && method === "PUT") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ ...SHARE, role: "editor" }) }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();
    await selectMembers();

    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "bob@example.com" } });
    await chooseOption(screen.getByLabelText("Role for new share"), "Editor");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
      expect(call).toBeDefined();
      const [url, init] = call as [RequestInfo, RequestInit];
      expect(String(url)).toBe(SHARES_URL);
      expect(JSON.parse(String(init.body))).toEqual({ email: "bob@example.com", role: "editor" });
    });
  });

  it("adding a share: type a few characters -> pick from known people -> PUT carries the picked email", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === PUBLIC_LINK_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null, slug: null }) }));
      }
      if (url === "/api/users/suggest?q=bo" && method === "GET") {
        const users = [{ userId: SHARE.userId, email: SHARE.email, displayName: SHARE.displayName }];
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ users }) }));
      }
      if (url === SHARES_URL && method === "PUT") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(SHARE) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();
    await selectMembers();

    const box = screen.getByRole("combobox", { name: "Email address" });
    // Still type="email" (one address at a time, unlike group add-member's multi-address text field).
    expect(box).toHaveAttribute("type", "email");
    expect(box).not.toHaveAttribute("inputmode");
    fireEvent.change(box, { target: { value: "bo" } });
    const option = await screen.findByRole("option", { name: /bob@example\.com/ });
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(box).toHaveValue("bob@example.com");
    expect(screen.getByRole("heading", { name: "Share note" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
      expect(call).toBeDefined();
      expect(JSON.parse(String((call as [RequestInfo, RequestInit])[1].body))).toEqual({ email: "bob@example.com", role: "viewer" });
    });
  });

  it("add share fails (user_not_found) -> shows the matching text", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === PUBLIC_LINK_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null, slug: null }) }));
      }
      if (url === SHARES_URL && method === "PUT") {
        return Promise.resolve(
          fakeResponse({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ error: { code: "user_not_found", message: "nope" } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();
    await selectMembers();

    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "ghost@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.getByText("We couldn't find that user.")).toBeInTheDocument());
  });

  it("removing a share sends DELETE /shares/:userId", async () => {
    let listed = [SHARE];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(listed) }));
      }
      if (url === PUBLIC_LINK_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null, slug: null }) }));
      }
      if (url === `${SHARES_URL}/${SHARE.userId}` && method === "DELETE") {
        listed = [];
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();
    // With existing members the latch derives to 'restricted members' by itself, so no need to click the radio.
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());

    await waitFor(() => expect(screen.getByText(SHARE.email)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: `Remove ${SHARE.email}` }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");
      expect(call).toBeDefined();
      expect(String((call as [RequestInfo, RequestInit])[0])).toBe(`${SHARES_URL}/${SHARE.userId}`);
    });
    await waitFor(() => expect(screen.getByText("No one else has access yet.")).toBeInTheDocument());
  });

  describe("#395 second confirmation when removing a member", () => {
    async function openMembers(onCall?: (method: string, url: string) => Response | undefined) {
      const stub = stubRoutedFetch({ shares: [SHARE], token: null, onCall });
      renderDialog();
      await openDialog();
      await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());
      await waitFor(() => expect(screen.getByText(SHARE.email)).toBeInTheDocument());
      return stub;
    }
    const deletes = (stub: { calls: Array<{ method: string; url: string }> }) => stub.calls.filter((c) => c.method === "DELETE");

    it("pressing remove first shows a confirm with the email; cancel sends no DELETE and the member stays", async () => {
      const stub = await openMembers();
      fireEvent.click(screen.getByRole("button", { name: `Remove ${SHARE.email}` }));
      const confirm = await screen.findByRole("alert");
      expect(within(confirm).getByText(/bob@example\.com/)).toBeInTheDocument();
      expect(within(confirm).queryByText(/You will lose access/)).not.toBeInTheDocument();
      expect(deletes(stub)).toHaveLength(0);

      fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: `Remove ${SHARE.email}` })).toHaveFocus();
      expect(deletes(stub)).toHaveLength(0);
      expect(screen.getByText(SHARE.email)).toBeInTheDocument();
    });

    it("only confirming sends DELETE, the list updates", async () => {
      const stub = await openMembers();
      fireEvent.click(screen.getByRole("button", { name: `Remove ${SHARE.email}` }));
      fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(deletes(stub)).toEqual([{ method: "DELETE", url: `${SHARES_URL}/${SHARE.userId}` }]));
      await waitFor(() => expect(screen.getByText("No one else has access yet.")).toBeInTheDocument());
    });

    it("removing yourself: the text says you lose access to this note, different from a normal removal", async () => {
      const me = { id: SHARE.userId, email: SHARE.email, handle: "bob", displayName: "Bob", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null } satisfies UserDto;
      const stub = await openMembers((method, url) =>
        url === "/api/auth/me" && method === "GET"
          ? fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(me) })
          : undefined,
      );
      fireEvent.click(screen.getByRole("button", { name: `Remove ${SHARE.email}` }));
      const confirm = await screen.findByRole("alert");
      await waitFor(() => expect(within(confirm).getByText(/You will lose access to this note/)).toBeInTheDocument());
      expect(within(confirm).getByText(/bob@example\.com/)).toBeInTheDocument();
      expect(deletes(stub)).toHaveLength(0);
    });
  });

  it("changing the role sends PUT {email, role} to the same endpoint", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([SHARE]) }));
      }
      if (url === PUBLIC_LINK_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null, slug: null }) }));
      }
      if (url === SHARES_URL && method === "PUT") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ ...SHARE, role: "editor" }) }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());

    await waitFor(() => expect(screen.getByText(SHARE.email)).toBeInTheDocument());
    await chooseOption(screen.getByLabelText(`Role for ${SHARE.email}`), "Editor");

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
      expect(call).toBeDefined();
      const [, init] = call as [RequestInfo, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ email: SHARE.email, role: "editor" });
    });
  });
});



const PUBLIC_LINK_URL = `/api/notes/${NOTE.id}/public-link`;
const TOKEN = "T".repeat(43);
const PUBLIC_WIDTH_URL = `/api/notes/${NOTE.id}/public-width`;

/** Routable fetch stub that can delay per URL: URLs in `pending` return a pending promise the test resolves manually (the latch cases need it to pin "no radio selected until both queries are in").
 * `shares` and `token` are **mutable state** (DELETE/PUT update them) so a refetch gets the post-action state; a static stub simulates a shape that isn't the real one and gives false greens. */
function stubRoutedFetch(opts: {
  shares?: ShareDto[];
  token?: string | null;
  /** Public alias (#122): mutable state like token (PUT/DELETE .../slug changes it). */
  slug?: string | null;
  /** Public page width (mutable state: PUT .../public-width changes it). */
  width?: NoteWidth;
  widthFail?: boolean;
  pending?: string[];
  onCall?: (method: string, url: string) => Response | Promise<Response> | undefined;
}) {
  const calls: Array<{ method: string; url: string }> = [];
  const resolvers = new Map<string, (r: Response) => void>();
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    const overridden = opts.onCall?.(method, url);
    if (overridden) return Promise.resolve(overridden);
    if (opts.pending?.includes(url) && method === "GET") {
      return new Promise<Response>((resolve) => resolvers.set(url, resolve));
    }
    if (url === SHARES_URL && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([...(opts.shares ?? [])]) }));
    }
    if (url === PUBLIC_LINK_URL && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: opts.token ?? null, slug: opts.slug ?? null, width: opts.width ?? "standard" }) }));
    }
    if (url === PUBLIC_LINK_URL && method === "PUT") {
      opts.token = TOKEN;
      // Regenerate leaves the alias alone and returns the full shape (server contract, pinned in apps/server/test/public-share.test.ts).
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: TOKEN, slug: opts.slug ?? null, width: opts.width ?? "standard" }) }));
    }
    if (url === PUBLIC_LINK_URL && method === "DELETE") {
      opts.token = null;
      opts.slug = null; // the server clears both in the same UPDATE
      return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
    }
    if (url === `${PUBLIC_LINK_URL}/slug` && method === "PUT") {
      const slug = (JSON.parse(String(init?.body)) as { slug: string }).slug;
      opts.slug = slug;
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: opts.token ?? null, slug, width: opts.width ?? "standard" }) }));
    }
    if (url === PUBLIC_WIDTH_URL && method === "PUT") {
      if (opts.widthFail) {
        return Promise.resolve(
          fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "x" } }) }),
        );
      }
      opts.width = (JSON.parse(String(init?.body)) as { width: NoteWidth }).width;
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ width: opts.width }) }));
    }
    if (url === `${PUBLIC_LINK_URL}/slug` && method === "DELETE") {
      opts.slug = null;
      return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
    }
    if (url.startsWith(`${SHARES_URL}/`) && method === "DELETE") {
      const userId = url.slice(`${SHARES_URL}/`.length);
      const idx = opts.shares?.findIndex((sh) => sh.userId === userId) ?? -1;
      if (opts.shares && idx >= 0) opts.shares.splice(idx, 1); // -1 would wrongly remove the last member (false-green seed)
      return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
    }
    if (url === SHARES_URL && method === "PUT") {
      opts.shares?.push(SHARE);
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(SHARE) }));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    fetchMock,
    resolve(url: string, response: Response) {
      resolvers.get(url)?.(response);
    },
  };
}

const SHARE2: ShareDto = {
  userId: "33333333-3333-3333-3333-333333333333",
  email: "carol@example.com",
  displayName: "Carol",
  role: "editor",
  avatar: null,
};

describe("ShareDialog three states (#72)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("latch: only derive once both queries have first returned data - no radio is selected before public-link returns, then with a token it lands on Public; an existing token **sends no PUT**", async () => {
    const stub = stubRoutedFetch({ shares: [], token: TOKEN, pending: [PUBLIC_LINK_URL] });
    renderDialog();
    await openDialog();

    // A jsdom single-stage mock would give a false green exactly here, hence two stages: shares returned, public-link pending -> no radio selected.
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).not.toBeChecked();
    }

    stub.resolve(PUBLIC_LINK_URL, fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: TOKEN }) }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());
    expect(stub.calls.filter((c) => c.method === "PUT" && c.url === PUBLIC_LINK_URL)).toHaveLength(0);
    // In the anonymous state the URL is split into the prefix `/p/` + a read-only input holding the token, so assert the token in the input's value, not a whole string.
    expect(screen.getByRole("textbox")).toHaveValue(TOKEN);
  });

  it("context panel gate: the default private state (zero members, zero links) doesn't render the member list / add form - they only appear after choosing restricted members", async () => {
    stubRoutedFetch({ shares: [], token: null });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());

    // Pins the gate itself: the panel mounts only when selection === 'members'.
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
    expect(screen.queryByText("No one else has access yet.")).not.toBeInTheDocument();
  });

  it("sticky: choosing restricted members with zero members doesn't bounce back (deriving private after a refetch doesn't overwrite the choice)", async () => {
    stubRoutedFetch({ shares: [], token: TOKEN });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Members only/ }));
    // The hook writes the cache directly (setQueryData, no refetch): token=null and shares=0 would derive private, but the radio must stay on restricted members.
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());
    expect(screen.getByRole("radio", { name: /Private/ })).not.toBeChecked();
  });

  it("sticky: removing the last member in the restricted members state doesn't bounce back (operation sequence of the e2e share-revoke spec)", async () => {
    stubRoutedFetch({ shares: [SHARE], token: null });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());

    fireEvent.click(screen.getByRole("button", { name: `Remove ${SHARE.email}` }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("Bob")).not.toBeInTheDocument());
    expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked();
  });

  // The add form only exists under the restricted-members panel, so "adding in the private state" is unreachable; this covers the remaining half of the invariant: adding successfully doesn't make the radio get recomputed.
  it("sticky: after successfully adding a member with the add form in the restricted members state the radio stays there (deliberate - the radio is an action trigger)", async () => {
    stubRoutedFetch({ shares: [], token: null });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());

    await selectMembers();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());

    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "bob@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    // Wait for the member to really appear first (the stub's PUT pushes SHARE into the mutable list), otherwise "radio recomputed after adding" couldn't happen.
    await screen.findByText("Bob");
    expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked();
  });

  it("choosing Public (token null) -> one PUT, shows the link + Copy public link + Regenerate; Regenerate PUTs again", async () => {
    const stub = stubRoutedFetch({ shares: [], token: null });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Public link/ }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(TOKEN));
    expect(stub.calls.filter((c) => c.method === "PUT" && c.url === PUBLIC_LINK_URL)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Copy public link" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate link" }));
    await waitFor(() =>
      expect(stub.calls.filter((c) => c.method === "PUT" && c.url === PUBLIC_LINK_URL)).toHaveLength(2),
    );
  });

  it("private confirm flow: lists the number of members to be removed -> confirm -> **first DELETE public-link, then DELETE shares one by one**", async () => {
    const stub = stubRoutedFetch({ shares: [SHARE, SHARE2], token: TOKEN });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Private/ }));
    const confirm = await screen.findByRole("button", { name: /Remove 2 members and make private/ });
    fireEvent.click(confirm);

    await waitFor(() => {
      const deletes = stub.calls.filter((c) => c.method === "DELETE");
      expect(deletes.map((c) => c.url)).toEqual([
        PUBLIC_LINK_URL,
        `${SHARES_URL}/${SHARE.userId}`,
        `${SHARES_URL}/${SHARE2.userId}`,
      ]);
    });
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());
  });

  it("private confirm flow partial failure: first member DELETE 500 -> aborts (second isn't hit) + error toast + radio recomputed from the refetch + the remaining list is honest", async () => {
    const stub = stubRoutedFetch({
      shares: [SHARE, SHARE2],
      token: TOKEN,
      onCall: (method, url) => {
        if (method === "DELETE" && url === `${SHARES_URL}/${SHARE.userId}`) {
          return fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) });
        }
        if (method === "GET" && url === PUBLIC_LINK_URL && stub?.calls.some((c) => c.method === "DELETE")) {
          return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null }) });
        }
        return undefined;
      },
    });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Private/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Remove 2 members and make private/ }));

    await waitFor(() => {
      const deletes = stub.calls.filter((c) => c.method === "DELETE");
      // 2 = public-link + the failed first member; the second member isn't hit (aborted).
      expect(deletes).toHaveLength(2);
    });
    // Both remain: the first member's DELETE failed server-side.
    await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());
    expect(screen.getByText("Carol")).toBeInTheDocument();
    // Refetch: token gone, members remain -> restricted members.
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());
  });


  it("choosing restricted members -> sends DELETE public-link and the member list is untouched (this is the revoke path's own function)", async () => {
    const stub = stubRoutedFetch({ shares: [SHARE], token: TOKEN });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Members only/ }));
    await waitFor(() =>
      expect(stub.calls.filter((c) => c.method === "DELETE" && c.url === PUBLIC_LINK_URL)).toHaveLength(1),
    );
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked();
  });

  it("revoke fails (DELETE 500) -> error toast + radio restored to Public + no PUT (a silent failure would show revoked while the link is still alive)", async () => {
    const stub = stubRoutedFetch({
      shares: [],
      token: TOKEN,
      onCall: (method, url) => {
        if (method === "DELETE" && url === PUBLIC_LINK_URL) {
          return fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) });
        }
        return undefined;
      },
    });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Members only/ }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());
    expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument();
    expect(stub.calls.filter((c) => c.method === "PUT" && c.url === PUBLIC_LINK_URL)).toHaveLength(0);
  });

  it("confirm flow cancelled (Keep members) -> zero DELETE, radio back to Public (explicit recompute point - load-bearing: without it the radio would rest on a false private state)", async () => {
    const stub = stubRoutedFetch({ shares: [SHARE], token: TOKEN });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Private/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep members" }));

    expect(stub.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked();
    expect(screen.queryByRole("button", { name: /make private/ })).not.toBeInTheDocument();
  });

  // The panel only mounts under selection==="members", and while the confirm flow hangs selection is already "private", so no Remove button can be clicked: the list is emptied externally instead
  // (mutable shares array + manual invalidateQueries, e.g. another tab removed the last member). The effect guards "list emptied to zero" regardless of cause.
  it("while the confirm flow hangs, the list is emptied to zero (externally) -> the effect completes the link revocation and the confirm row collapses (the action doesn't evaporate)", async () => {
    const shares = [SHARE];
    const stub = stubRoutedFetch({ shares, token: TOKEN });
    const queryClient = renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Private/ }));
    await screen.findByRole("button", { name: /make private/ });

    shares.length = 0;
    await queryClient.invalidateQueries({ queryKey: ["shares", NOTE.id] });

    await waitFor(() =>
      expect(stub.calls.filter((c) => c.method === "DELETE" && c.url === PUBLIC_LINK_URL)).toHaveLength(1),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: /make private/ })).not.toBeInTheDocument());
    expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked();
  });

  it("closing and reopening the dialog -> selection resets and latches again from the new data (the choice lives only until the dialog closes)", async () => {
    stubRoutedFetch({ shares: [], token: TOKEN });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public link/ })).toBeChecked());

    fireEvent.click(screen.getByRole("radio", { name: /Members only/ }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("radio")).not.toBeInTheDocument());
    // Choosing members DELETEd the token; on reopen zero members + null token -> private.
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());
  });
});

// One anonymous toggle + one link + at most three buttons. The mode is derived from existing data (slug null = anonymous ON, slug set = OFF), not separate state - see the JSDoc of `PublicLinkPanel` in ShareDialog.tsx.

const HEX16_RE = /^[0-9a-f]{16}$/;

describe("ShareDialog public link panel: anonymous toggle", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openPublicDialog(opts: Parameters<typeof stubRoutedFetch>[0]) {
    const stub = stubRoutedFetch(opts);
    const queryClient = renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /^Public link/ })).toBeChecked());
    return { stub, queryClient };
  }

  it("already public with no alias -> toggle shows anonymous on, link is /p/<token>, no editable input, only two buttons", async () => {
    await openPublicDialog({ shares: [], token: TOKEN });

    expect(screen.getByRole("switch", { name: /Anonymous/ })).toBeChecked();
    // URL is split into the prefix `/p/` + a read-only input holding the token, so assert the token in the input's value.
    expect(screen.getByRole("textbox")).toHaveValue(TOKEN);
    // Anonymous state is still an input (selectable, copyable) but **readOnly**: not being customizable is this state's load-bearing property.
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    expect(screen.queryByLabelText("Custom public link")).not.toBeInTheDocument();
    const panel = screen.getByRole("group", { name: "Public link" });
    expect(within(panel).getAllByRole("button")).toHaveLength(2);
    expect(within(panel).getByRole("button", { name: "Copy public link" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Regenerate link" })).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Save custom URL" })).not.toBeInTheDocument();
  });

  it("turning anonymous off -> sends set-slug once (16 hex chars), link becomes /p/<handle>/<slug>, plus a Save button and a guessable warning", async () => {
    const { stub } = await openPublicDialog({ shares: [], token: TOKEN });

    fireEvent.click(screen.getByRole("switch", { name: /Anonymous/ }));

    await waitFor(() =>
      expect(stub.calls.filter((c) => c.method === "PUT" && c.url === `${PUBLIC_LINK_URL}/slug`)).toHaveLength(1),
    );
    const putCall = stub.calls.find((c) => c.method === "PUT" && c.url === `${PUBLIC_LINK_URL}/slug`);
    expect(putCall).toBeDefined();

    await waitFor(() => expect(screen.getByRole("switch", { name: /Anonymous/ })).not.toBeChecked());
    const input = screen.getByLabelText("Custom public link") as HTMLInputElement;
    expect(input.value).toMatch(HEX16_RE);
    expect(screen.getByText(`/p/${NOTE.ownerHandle}/`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save custom URL" })).toBeInTheDocument();
    expect(screen.getByText(/can be guessed/)).toBeInTheDocument();
  });

  it("OFF state: changing to a custom name and saving -> sends the normalized value, the link follows", async () => {
    const { stub, queryClient } = await openPublicDialog({ shares: [], token: TOKEN, slug: "old-alias" });

    fireEvent.change(screen.getByLabelText("Custom public link"), { target: { value: "My-Custom" } });
    fireEvent.click(screen.getByRole("button", { name: "Save custom URL" }));

    await waitFor(() =>
      expect(stub.calls).toContainEqual({ method: "PUT", url: `${PUBLIC_LINK_URL}/slug` }),
    );
    const putCall = stub.fetchMock.mock.calls.find(
      ([input, init]) => String(input) === `${PUBLIC_LINK_URL}/slug` && (init as RequestInit)?.method === "PUT",
    );
    expect(JSON.parse(String((putCall as [unknown, RequestInit])[1].body))).toEqual({ slug: "my-custom" });
    expect(queryClient.getQueryData(["public-link", NOTE.id])).toEqual({ token: TOKEN, slug: "my-custom", width: "standard" });
  });

  it("OFF state: pressing Regenerate -> sends a new random slug (different from the previous one)", async () => {
    const { stub } = await openPublicDialog({ shares: [], token: TOKEN, slug: "old-alias" });

    fireEvent.click(screen.getByRole("button", { name: "Regenerate link" }));
    await waitFor(() =>
      expect(stub.calls.filter((c) => c.method === "PUT" && c.url === `${PUBLIC_LINK_URL}/slug`)).toHaveLength(1),
    );
    const firstValue = (screen.getByLabelText("Custom public link") as HTMLInputElement).value;
    expect(firstValue).toMatch(HEX16_RE);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate link" }));
    await waitFor(() =>
      expect(stub.calls.filter((c) => c.method === "PUT" && c.url === `${PUBLIC_LINK_URL}/slug`)).toHaveLength(2),
    );
    const secondValue = (screen.getByLabelText("Custom public link") as HTMLInputElement).value;
    expect(secondValue).toMatch(HEX16_RE);
    expect(secondValue).not.toBe(firstValue);
  });

  // Regenerate must rotate the token too: otherwise a leaked /p/<token> link has no rotation path once a custom public URL is set.
  it("OFF state: pressing Regenerate -> PUTs both public-link (new token) and slug (new slug), new slug differs from the old", async () => {
    const { stub } = await openPublicDialog({ shares: [], token: TOKEN, slug: "old-alias" });

    fireEvent.click(screen.getByRole("button", { name: "Regenerate link" }));

    await waitFor(() => {
      expect(stub.calls.filter((c) => c.method === "PUT" && c.url === PUBLIC_LINK_URL)).toHaveLength(1);
      expect(stub.calls.filter((c) => c.method === "PUT" && c.url === `${PUBLIC_LINK_URL}/slug`)).toHaveLength(1);
    });
    // Token PUT before slug PUT: rotate the token first so a new slug isn't forced out with the old token.
    const tokenCallIndex = stub.calls.findIndex((c) => c.method === "PUT" && c.url === PUBLIC_LINK_URL);
    const slugCallIndex = stub.calls.findIndex((c) => c.method === "PUT" && c.url === `${PUBLIC_LINK_URL}/slug`);
    expect(tokenCallIndex).toBeGreaterThanOrEqual(0);
    expect(slugCallIndex).toBeGreaterThan(tokenCallIndex);

    const newValue = (screen.getByLabelText("Custom public link") as HTMLInputElement).value;
    expect(newValue).toMatch(HEX16_RE);
    expect(newValue).not.toBe("old-alias");
  });

  it("failure recovery: set-slug returns an error -> the toggle bounces back, error shown, the screen must not claim it switched", async () => {
    const { stub } = await openPublicDialog({
      shares: [],
      token: TOKEN,
      onCall: (method, url) =>
        method === "PUT" && url === `${PUBLIC_LINK_URL}/slug`
          ? fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) })
          : undefined,
    });

    fireEvent.click(screen.getByRole("switch", { name: /Anonymous/ }));

    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Anonymous/ })).toBeChecked();
    expect(screen.queryByLabelText("Custom public link")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue(TOKEN);
    expect(stub.calls.filter((c) => c.method === "PUT" && c.url === `${PUBLIC_LINK_URL}/slug`)).toHaveLength(1);
  });

  it("turning anonymous on -> sends clear-slug, link returns to /p/<token>", async () => {
    const { stub } = await openPublicDialog({ shares: [], token: TOKEN, slug: "old-alias" });
    expect(screen.getByRole("switch", { name: /Anonymous/ })).not.toBeChecked();

    fireEvent.click(screen.getByRole("switch", { name: /Anonymous/ }));

    await waitFor(() =>
      expect(stub.calls).toContainEqual({ method: "DELETE", url: `${PUBLIC_LINK_URL}/slug` }),
    );
    await waitFor(() => expect(screen.getByRole("switch", { name: /Anonymous/ })).toBeChecked());
    expect(screen.getByRole("textbox")).toHaveValue(TOKEN);
    expect(screen.queryByLabelText("Custom public link")).not.toBeInTheDocument();
  });

  it("private state doesn't render the public link panel", async () => {
    stubRoutedFetch({ shares: [], token: null });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());
    expect(screen.queryByRole("switch", { name: /Anonymous/ })).not.toBeInTheDocument();
  });

  it("409 public_slug_taken -> shows the matching text; the input value is kept (so the user can edit and retry)", async () => {
    await openPublicDialog({
      shares: [],
      token: TOKEN,
      slug: "old-alias",
      onCall: (method, url) =>
        method === "PUT" && url === `${PUBLIC_LINK_URL}/slug`
          ? fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "public_slug_taken", message: "x" } }) })
          : undefined,
    });
    fireEvent.change(screen.getByLabelText("Custom public link"), { target: { value: "taken" } });
    fireEvent.click(screen.getByRole("button", { name: "Save custom URL" }));

    expect(await screen.findByText("That public URL is already used by another of your notes.")).toBeInTheDocument();
    expect(screen.getByLabelText("Custom public link")).toHaveValue("taken");
  });

  it("client-side validation matches the server: illegal characters are blocked in place, no API call", async () => {
    const { stub } = await openPublicDialog({ shares: [], token: TOKEN, slug: "old-alias" });
    fireEvent.change(screen.getByLabelText("Custom public link"), { target: { value: "bad_alias" } });
    expect(screen.getByText("Only letters, numbers, and hyphens are allowed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save custom URL" })).toBeDisabled();
    expect(stub.calls.filter((c) => c.url.endsWith("/slug") && c.method === "PUT")).toHaveLength(0);
  });

  // The fallback UI (`copyText` failing both ways -> `ManualCopyField`, see `lib/clipboard.ts`) still lives on the PublicCopyButton path.

  it("non-secure context and execCommand unavailable -> shows the URL for the user to copy themselves", async () => {
    await openPublicDialog({ shares: [], token: TOKEN });
    vi.stubGlobal("navigator", {}); // plain-http LAN address: the whole clipboard API doesn't exist
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => false), configurable: true, writable: true });

    fireEvent.click(screen.getByRole("button", { name: "Copy public link" }));

    // The fallback must be selectable text, not a toast (a Radix toast root has `userSelect: none` and horizontal drags are eaten by swipe-to-dismiss).
    const manual = await screen.findByLabelText(
      "Couldn't copy automatically — select the link below and copy it yourself.",
    );
    expect(manual).toHaveValue(`${window.location.origin}/p/${TOKEN}`);
    expect(manual).toHaveAttribute("readonly");
  });

  it("the manual copy field auto-selects only once when it appears, later re-renders don't steal focus", async () => {
    const { queryClient } = await openPublicDialog({ shares: [], token: TOKEN });
    vi.stubGlobal("navigator", {});
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => false), configurable: true, writable: true });

    fireEvent.click(screen.getByRole("button", { name: "Copy public link" }));

    const manual = await screen.findByLabelText(
      "Couldn't copy automatically — select the link below and copy it yourself.",
    );
    const selectSpy = vi.spyOn(manual as HTMLInputElement, "select");

    // An unrelated re-render (new element identity, as in renderDialog above, so React really re-renders).
    queryClient.rerender();
    queryClient.rerender();

    expect(selectSpy).not.toHaveBeenCalled();
  });
});

// With a token the private confirm row must mention the public link (including the custom public URL): dropping the token branch back to confirmHint goes red.
describe("private confirm flow text (#122)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("with a token the confirm row uses confirmHintWithLink (mentions the custom public URL)", async () => {
    stubRoutedFetch({ shares: [SHARE], token: TOKEN });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /^Public link/ })).toBeChecked());
    fireEvent.click(screen.getByRole("radio", { name: /Private/ }));
    expect(
      await screen.findByText(/turns off the public link \(including its custom public URL\)/),
    ).toBeInTheDocument();
  });
});

// `aria-label` stays fixed ("Share") because the e2e share-revoke spec finds the button by accessible name; the state is conveyed via `title`.
describe("ShareDialog trigger icon (by share state, #72)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function triggerButton() {
    // A string name is an exact match already: `exact` can't be added (ByRoleOptions rejects the key; only tsc catches it, vitest strips types).
    return screen.getByRole("button", { name: "Share" });
  }

  it("private (no token, zero members) -> title is the private state; while loading no state is guessed and the accessible name stays Share", async () => {
    const stub = stubRoutedFetch({ shares: [], token: null, pending: [SHARES_URL, PUBLIC_LINK_URL] });
    renderDialog();

    // First stage: both queries pending, no state text (no flicker, no guessing).
    expect(triggerButton()).not.toHaveAttribute("title");
    expect(triggerButton()).toHaveAccessibleName("Share");

    stub.resolve(SHARES_URL, fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    stub.resolve(
      PUBLIC_LINK_URL,
      fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null, slug: null }) }),
    );

    await waitFor(() => expect(triggerButton()).toHaveAttribute("title", "Private — only you have access"));
    expect(triggerButton()).toHaveAccessibleName("Share");
    // title / accessible name only show "changed or not": degrading TriggerIcon to a fixed Share icon would stay green, so assert the icon itself (data-icon, see ui/icons.tsx).
    expect(triggerButton().querySelector("svg")).toHaveAttribute("data-icon", "lock");
  });

  it("restricted members (no token, has members) -> title is the members state; accessible name stays Share", async () => {
    const stub = stubRoutedFetch({ shares: [SHARE], token: null, pending: [SHARES_URL, PUBLIC_LINK_URL] });
    renderDialog();

    expect(triggerButton()).not.toHaveAttribute("title");

    stub.resolve(SHARES_URL, fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([SHARE]) }));
    stub.resolve(
      PUBLIC_LINK_URL,
      fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null, slug: null }) }),
    );

    await waitFor(() => expect(triggerButton()).toHaveAttribute("title", "Shared with members you invited"));
    expect(triggerButton()).toHaveAccessibleName("Share");
    expect(triggerButton().querySelector("svg")).toHaveAttribute("data-icon", "share");
  });

  it("public (has token) -> title is the public state; accessible name stays Share", async () => {
    const stub = stubRoutedFetch({ shares: [], token: TOKEN, pending: [SHARES_URL, PUBLIC_LINK_URL] });
    renderDialog();

    expect(triggerButton()).not.toHaveAttribute("title");

    stub.resolve(SHARES_URL, fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    stub.resolve(
      PUBLIC_LINK_URL,
      fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: TOKEN, slug: null }) }),
    );

    await waitFor(() => expect(triggerButton()).toHaveAttribute("title", "Public — anyone with the link can view"));
    expect(triggerButton()).toHaveAccessibleName("Share");
    expect(triggerButton().querySelector("svg")).toHaveAttribute("data-icon", "globe");
  });
});

// Group notes (#175): no per-person sharing, access comes from the group role; only roles that can manage the public link see the public link switch (no alias). The share button looks at `permissions.read`.

const GROUP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
/** Regular member of a group note: read/edit, can't manage the public link; `ownerHandle`/`ownerId` are null (owned by the group). */
const GROUP_NOTE: NoteDto = {
  ...NOTE,
  ownerId: null,
  ownerHandle: null,
  role: "editor",
  groupId: GROUP_ID,
  group: { id: GROUP_ID, name: "Workshop A" },
  permissions: { ...EDITOR_PERMS },
};
/** Group admin: `managePublicLink` (and delete/changeSlug) true; `manageShares`/`moveToGroup` always false. */
const GROUP_NOTE_ADMIN: NoteDto = {
  ...GROUP_NOTE,
  permissions: { ...EDITOR_PERMS, delete: true, managePublicLink: true, changeSlug: true },
};

/** fetch dispatch for group notes: only the three public-link verbs; everything else (especially `/shares`) throws, since the group version must not send shares.
 * `onCall` returning non-undefined wins (a pending promise = loading, 500 = failure shape). */
function stubGroupNoteFetch(
  opts: { token?: string | null; width?: NoteWidth; onCall?: (method: string, url: string) => Promise<Response> | undefined } = {},
) {
  const calls: Array<{ method: string; url: string }> = [];
  let token = opts.token ?? null;
  let width: NoteWidth = opts.width ?? "standard";
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url });
      const overridden = opts.onCall?.(method, url);
      if (overridden) return overridden;
      if (url === PUBLIC_LINK_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token, slug: null, width }) }));
      }
      if (url === PUBLIC_LINK_URL && method === "PUT") {
        token = TOKEN;
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token, slug: null, width }) }));
      }
      if (url === PUBLIC_LINK_URL && method === "DELETE") {
        token = null;
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      if (url === PUBLIC_WIDTH_URL && method === "PUT") {
        width = (JSON.parse(String(init?.body)) as { width: NoteWidth }).width;
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ width }) }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
    }),
  );
  return calls;
}

/** The group version's title is also "Access" (`ShareGroup`), so it's there as soon as it opens. */
async function openGroupDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  await waitFor(() => expect(screen.getByText("Access")).toBeInTheDocument());
}

/** Common shape of the group panel: no radio, no member area, no Group dropdown; an explanatory line (with the group name) and a 'Group settings' link. */
function expectGroupPanelShape() {
  const dialog = screen.getByRole("dialog");
  // The dialog description is a group-specific sentence (readers can open this panel too, and "manage who can view or edit" is false for them).
  expect(dialog).toHaveAccessibleDescription(
    "Group members access this note according to their role's permissions. Public links are anonymous only.",
  );
  expect(within(dialog).queryByText("Manage who can view or edit this note.")).not.toBeInTheDocument();
  expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
  expect(within(dialog).queryByText("Group members")).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
  expect(within(dialog).queryByLabelText("Email address")).not.toBeInTheDocument();
  expect(within(dialog).getByText(/In "Workshop A", every member whose role can read has access\./)).toBeInTheDocument();
  const link = within(dialog).getByRole("link", { name: "Group settings" });
  expect(link).toHaveAttribute("href", `/groups/${GROUP_ID}`);
  return link;
}

describe("group notes (#175)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("regular member: share button present; panel has no radio / member area / Group dropdown, has the explanatory line and the Group settings link (clicking closes the panel); no /shares or /public-link requests", async () => {
    const calls = stubGroupNoteFetch();
    renderDialog(GROUP_NOTE);
    await openGroupDialog();

    const link = expectGroupPanelShape();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();

    fireEvent.click(link);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.filter((c) => c.url.includes("/shares"))).toEqual([]);
    expect(calls.filter((c) => c.url.includes("/public-link"))).toEqual([]);
  });

  it("read-only role (read true, edit false): still sees the share button and the group panel, zero fetch", async () => {
    const calls = stubGroupNoteFetch();
    renderDialog({ ...GROUP_NOTE, role: "viewer", permissions: { ...VIEWER_PERMS } });
    await openGroupDialog();

    expectGroupPanelShape();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("admin (managePublicLink): GET /public-link; on -> PUT -> link panel (copy, regenerate) with no Anonymous switch or alias field; off -> DELETE", async () => {
    const calls = stubGroupNoteFetch();
    renderDialog(GROUP_NOTE_ADMIN);
    await openGroupDialog();
    expectGroupPanelShape();

    const toggle = await screen.findByRole("switch", { name: "Public link" });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).not.toBeChecked();
    expect(calls).toContainEqual({ method: "GET", url: PUBLIC_LINK_URL });

    fireEvent.click(toggle);
    await waitFor(() => expect(calls).toContainEqual({ method: "PUT", url: PUBLIC_LINK_URL }));
    const panel = await screen.findByRole("group", { name: "Public link" });
    expect(within(panel).getByRole("button", { name: "Copy public link" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Regenerate link" })).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Save custom URL" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByText("Anonymous link")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Custom public link" })).not.toBeInTheDocument();
    // A group note's link is the anonymous form /p/<token> (no handle to build an alias from).
    expect(within(panel).getByRole("textbox", { name: "Public link URL" })).toHaveValue(TOKEN);
    expect(screen.getByRole("switch", { name: "Public link" })).toBeChecked();

    fireEvent.click(screen.getByRole("switch", { name: "Public link" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "DELETE", url: PUBLIC_LINK_URL }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Public link" })).not.toBeInTheDocument());
    expect(calls.filter((c) => c.url.includes("/shares"))).toEqual([]);
  });

  it("trigger button: admin with a token -> public; admin without a token -> group (group name); regular member (doesn't query public-link) -> group", async () => {
    const trigger = () => screen.getByRole("button", { name: "Share" });

    stubGroupNoteFetch({ token: TOKEN });
    const first = renderDialog(GROUP_NOTE_ADMIN);
    await waitFor(() => expect(trigger()).toHaveAttribute("title", "Public — anyone with the link can view"));
    expect(trigger().querySelector("svg")).toHaveAttribute("data-icon", "globe");
    first.clear();
    cleanup();
    vi.unstubAllGlobals();

    stubGroupNoteFetch({ token: null });
    renderDialog(GROUP_NOTE_ADMIN);
    await waitFor(() => expect(trigger()).toHaveAttribute("title", 'Members of "Workshop A" have access'));
    expect(trigger().querySelector("svg")).toHaveAttribute("data-icon", "users");
    cleanup();
    vi.unstubAllGlobals();

    const calls = stubGroupNoteFetch({ token: TOKEN });
    renderDialog(GROUP_NOTE);
    expect(trigger()).toHaveAttribute("title", 'Members of "Workshop A" have access');
    expect(trigger().querySelector("svg")).toHaveAttribute("data-icon", "users");
    expect(calls).toEqual([]);
  });

  it("trigger button doesn't guess: admin's public-link pending -> Share icon, no title; returned with a token -> Globe; query fails -> still Share, doesn't say group members can access", async () => {
    const trigger = () => screen.getByRole("button", { name: "Share" });
    let resolveGet: (r: Response) => void = () => {};
    stubGroupNoteFetch({
      onCall: (method, url) =>
        method === "GET" && url === PUBLIC_LINK_URL ? new Promise<Response>((resolve) => (resolveGet = resolve)) : undefined,
    });
    renderDialog(GROUP_NOTE_ADMIN);
    await waitFor(() => expect(trigger().querySelector("svg")).toHaveAttribute("data-icon", "share"));
    expect(trigger()).not.toHaveAttribute("title");
    resolveGet(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: TOKEN, slug: null }) }));
    await waitFor(() => expect(trigger().querySelector("svg")).toHaveAttribute("data-icon", "globe"));
    cleanup();
    vi.unstubAllGlobals();

    const calls = stubGroupNoteFetch({
      token: TOKEN,
      onCall: (method, url) =>
        method === "GET" && url === PUBLIC_LINK_URL
          ? Promise.resolve(fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) }))
          : undefined,
    });
    const queryClient = renderDialog(GROUP_NOTE_ADMIN);
    await waitFor(() => expect(calls).toContainEqual({ method: "GET", url: PUBLIC_LINK_URL }));
    // Wait until the query has landed in the error state (not still pending), otherwise this measures loading and can't tell the two shapes apart.
    await waitFor(() => expect(queryClient.getQueryState(["public-link", NOTE.id])?.status).toBe("error"));
    expect(trigger().querySelector("svg")).toHaveAttribute("data-icon", "share");
    expect(trigger()).not.toHaveAttribute("title");
  });

  it("admin's public-link query fails -> the panel shows an error alert, the switch is disabled", async () => {
    stubGroupNoteFetch({
      onCall: (method, url) =>
        method === "GET" && url === PUBLIC_LINK_URL
          ? Promise.resolve(fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) }))
          : undefined,
    });
    renderDialog(GROUP_NOTE_ADMIN);
    await openGroupDialog();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong. Please try again.");
    expect(screen.getByRole("switch", { name: "Public link" })).toBeDisabled();
  });

  it("admin enabling the public link fails (PUT 500) -> error toast, the switch stays unchecked, no link panel", async () => {
    const calls = stubGroupNoteFetch({
      onCall: (method, url) =>
        method === "PUT" && url === PUBLIC_LINK_URL
          ? Promise.resolve(fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) }))
          : undefined,
    });
    renderDialog(GROUP_NOTE_ADMIN);
    await openGroupDialog();
    const toggle = await screen.findByRole("switch", { name: "Public link" });
    await waitFor(() => expect(toggle).not.toBeDisabled());

    fireEvent.click(toggle);
    await waitFor(() => expect(calls).toContainEqual({ method: "PUT", url: PUBLIC_LINK_URL }));
    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Public link" })).not.toBeDisabled());
    expect(screen.getByRole("switch", { name: "Public link" })).not.toBeChecked();
    expect(screen.queryByRole("group", { name: "Public link" })).not.toBeInTheDocument();
  });

  it("personal notes look at permissions.manageShares: role is owner but manageShares false -> no share button, zero fetch", () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("should not fetch")));
    vi.stubGlobal("fetch", fetchMock);

    renderDialog({ ...NOTE, permissions: { ...OWNER_PERMS, manageShares: false } });

    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("personal note owner: the three-state radio as before, and no owning-group dropdown any more", async () => {
    const stub = stubRoutedFetch({ shares: [], token: null });
    renderDialog();
    await openDialog();

    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription("Manage who can view or edit this note.");
    expect(screen.queryByRole("combobox", { name: "Group this note belongs to" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Group" })).not.toBeInTheDocument();
    // #216: the move-into-group row is in the more menu; the share panel no longer sends `GET /api/groups` and has no dropdown.
    expect(stub.calls.filter((c) => c.url === "/api/groups")).toEqual([]);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText("Move or copy into a group")).not.toBeInTheDocument();
  });
});


const okResponse = (body: unknown, status = 200) =>
  fakeResponse({ ok: true, status, json: () => Promise.resolve(body) });

describe("#175", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    act(() => dismissAllToasts());
    vi.unstubAllGlobals();
  });

  it("#170: while the panel is open the note changes from group shape back to personal (shape after deleting a group transfer), the ['shares'] cache is the [] written at the move, the server's shares arrive late -> the radio doesn't latch before the new data arrives; after it does it lands on restricted members", async () => {
    const stub = stubRoutedFetch({ shares: [SHARE], token: null, pending: [SHARES_URL] });
    const queryClient = renderDialog(GROUP_NOTE);
    await openGroupDialog();

    queryClient.setQueryData(["shares", NOTE.id], []);
    queryClient.rerender(NOTE);

    const group = await screen.findByRole("radiogroup");
    // public-link has returned, the shares cache is [], the mount-triggered shares refetch is pending: "latch if cached" would stop on private here.
    await waitFor(() => expect(queryClient.getQueryState(["public-link", NOTE.id])?.status).toBe("success"));
    await act(async () => {});
    expect(group).toHaveAttribute("aria-busy", "true");
    for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked();

    stub.resolve(SHARES_URL, okResponse([SHARE]));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());
    expect(group).toHaveAttribute("aria-busy", "false");
  });

  it("#170 (panel-closed shape): cached shares is [] but the server has members -> opening the panel doesn't latch from the cache", async () => {
    const opts = { shares: [] as ShareDto[], token: null, pending: [] as string[] };
    const stub = stubRoutedFetch(opts);
    const queryClient = renderDialog();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Share" })).toHaveAttribute("title", "Private — only you have access"),
    );

    opts.shares.push(SHARE);
    opts.pending.push(SHARES_URL);
    await openDialog();
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "GET" && c.url === SHARES_URL)).toHaveLength(2));
    await waitFor(() =>
      expect(stub.calls.filter((c) => c.method === "GET" && c.url === PUBLIC_LINK_URL)).toHaveLength(2),
    );
    await waitFor(() => expect(queryClient.getQueryState(["public-link", NOTE.id])?.fetchStatus).toBe("idle"));
    await act(async () => {});
    expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-busy", "true");
    for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked();

    stub.resolve(SHARES_URL, okResponse([SHARE]));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Members only/ })).toBeChecked());
  });

  it("#216: personal notes (including an owner with moveToGroup true) and group notes: the share panel has no move-into-group row and doesn't send /api/groups", async () => {
    const stub = stubRoutedFetch({ shares: [], token: null });
    renderDialog(NOTE);
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());
    expect(screen.queryByRole("combobox", { name: "Group" })).not.toBeInTheDocument();
    expect(stub.calls.filter((c) => c.url === "/api/groups")).toEqual([]);
    cleanup();
    vi.unstubAllGlobals();

    const calls = stubGroupNoteFetch();
    renderDialog(GROUP_NOTE_ADMIN);
    await openGroupDialog();
    await screen.findByText(/every member whose role can read has access/);
    expect(screen.queryByRole("button", { name: "Copy to my notes" })).not.toBeInTheDocument(); // #216: it's in the more menu now
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText("Move or copy into a group")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/api/groups")).toEqual([]);
  });

  it("#170/key: while the panel is open switching to another personal note (the new note's shares/public-link pending) -> doesn't reuse the previous note's latch", async () => {
    const OTHER: NoteDto = { ...NOTE, id: "66666666-6666-6666-6666-666666666666", slug: "other" };
    stubRoutedFetch({
      shares: [],
      token: TOKEN,
      pending: [`/api/notes/${OTHER.id}/shares`, `/api/notes/${OTHER.id}/public-link`],
    });
    const queryClient = renderDialog(NOTE);
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Public/ })).toBeChecked());

    queryClient.rerender(OTHER);
    await act(async () => {});
    expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-busy", "true");
    for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("#170 (public-link half): shares are fresh, the ['public-link'] cache is the old token from before mounting, the server already has null and the refetch is pending -> doesn't latch to Public; after release it lands on private", async () => {
    const opts = { shares: [] as ShareDto[], token: null, pending: [] as string[] };
    const stub = stubRoutedFetch(opts);
    const queryClient = renderDialog();
    await waitFor(() => expect(queryClient.getQueryState(["public-link", NOTE.id])?.status).toBe("success"));
    // The cache holds an old token (e.g. the link was just turned off elsewhere and not refetched here); the refetch on opening the panel is pending.
    queryClient.setQueryData(["public-link", NOTE.id], { token: TOKEN, slug: null });
    opts.pending.push(PUBLIC_LINK_URL);
    await openDialog();
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "GET" && c.url === SHARES_URL)).toHaveLength(2));
    await waitFor(() => expect(queryClient.getQueryState(["shares", NOTE.id])?.fetchStatus).toBe("idle"));
    await waitFor(() =>
      expect(stub.calls.filter((c) => c.method === "GET" && c.url === PUBLIC_LINK_URL)).toHaveLength(2),
    );
    await act(async () => {});
    expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-busy", "true");
    for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked();

    stub.resolve(PUBLIC_LINK_URL, okResponse({ token: null, slug: null }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());
  });
});

describe("public page width (#297)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const widthCalls = (calls: Array<{ method: string; url: string }>) =>
    calls.filter((c) => c.method === "PUT" && c.url === PUBLIC_WIDTH_URL);

  it("already public -> has the width dropdown, value from the cache, three options", async () => {
    stubRoutedFetch({ shares: [], token: TOKEN, width: "wide" });
    renderDialog();
    await openDialog();
    const select = await screen.findByLabelText("Public page width");
    await waitFor(() => expect(selectedValue(select)).toBe("wide"));
    expect(await optionLabels(select)).toEqual(["Standard", "Wide", "Full width"]);
  });

  it("not public -> no width dropdown", async () => {
    stubRoutedFetch({ shares: [], token: null });
    renderDialog();
    await openDialog();
    await waitFor(() => expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked());
    expect(screen.queryByLabelText("Public page width")).not.toBeInTheDocument();
  });

  it("changing to full width -> exactly one PUT, correct body, cache merges only width", async () => {
    // Hold the PUT first so the "request in flight" state is observable.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = stubRoutedFetch({
      shares: [],
      token: TOKEN,
      onCall: (method, url) =>
        method === "PUT" && url === PUBLIC_WIDTH_URL
          ? (gate.then(() => fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ width: "full" }) })))
          : undefined,
    });
    const queryClient = renderDialog();
    await openDialog();
    const select = await screen.findByLabelText("Public page width");
    await chooseOption(select, "Full width");
    // In flight: the dropdown shows the chosen value, doesn't bounce back to the old one.
    expect(selectedValue(select)).toBe("full");
    expect(select).toBeDisabled();
    release();
    await waitFor(() => expect(widthCalls(stub.calls)).toHaveLength(1));
    const putCall = stub.fetchMock.mock.calls.find(
      ([input, init]) => String(input) === PUBLIC_WIDTH_URL && (init as RequestInit)?.method === "PUT",
    );
    expect(JSON.parse(String((putCall as [unknown, RequestInit])[1].body))).toEqual({ width: "full" });
    await waitFor(() =>
      expect(queryClient.getQueryData(["public-link", NOTE.id])).toEqual({ token: TOKEN, slug: null, width: "full" }),
    );
    expect(selectedValue(screen.getByLabelText("Public page width"))).toBe("full");
  });

  it("PUT fails -> error shown, dropdown back to the original value, cache untouched", async () => {
    stubRoutedFetch({ shares: [], token: TOKEN, widthFail: true });
    const queryClient = renderDialog();
    await openDialog();
    await chooseOption(await screen.findByLabelText("Public page width"), "Full width");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(selectedValue(screen.getByLabelText("Public page width"))).toBe("standard");
    expect(queryClient.getQueryData(["public-link", NOTE.id])).toEqual({ token: TOKEN, slug: null, width: "standard" });
  });

  it("group note: admin has the width dropdown and can change it; a regular member doesn't", async () => {
    const calls = stubGroupNoteFetch({ token: TOKEN });
    renderDialog(GROUP_NOTE_ADMIN);
    await openGroupDialog();
    const select = await screen.findByLabelText("Public page width");
    await chooseOption(select, "Wide");
    await waitFor(() => expect(widthCalls(calls)).toHaveLength(1));
    await waitFor(() => expect(selectedValue(screen.getByLabelText("Public page width"))).toBe("wide"));
    cleanup();
    vi.unstubAllGlobals();

    stubGroupNoteFetch({ token: TOKEN });
    renderDialog(GROUP_NOTE);
    await openGroupDialog();
    expect(screen.queryByLabelText("Public page width")).not.toBeInTheDocument();
  });
});

describe("ShareDialog list avatars", () => {
  const REF = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", v: 5 };

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    window.history.replaceState(null, "", `/notes/${NOTE.id}`);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function renderWith(share: ShareDto) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === SHARES_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([share]) }));
        if (url === PUBLIC_LINK_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null, slug: null }) }));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    renderDialog();
    await openDialog();
    await selectMembers();
    const name = await screen.findByText("Bob");
    return { name, avatar: name.parentElement!.previousElementSibling as HTMLElement };
  }

  it("with avatar: the row starts with the avatar (before the name block), src carries the version, lazy, outer aria-hidden", async () => {
    const { avatar } = await renderWith({ ...SHARE, avatar: REF });
    const img = avatar.querySelector("img");
    expect(img).toHaveAttribute("src", avatarUrl(REF.id, REF.v));
    expect(img).toHaveAttribute("loading", "lazy");
    expect(avatar).toHaveAttribute("aria-hidden", "true");
  });

  it("avatar null: initial letter, no img; the name <p>'s textContent still equals displayName", async () => {
    const { name, avatar } = await renderWith(SHARE);
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("B");
    expect(name.textContent).toBe("Bob");
  });

  it("old server without the avatar field: no throw, shows the initial", async () => {
    const share = { ...SHARE } as Record<string, unknown>;
    delete share.avatar;
    const { avatar } = await renderWith(share as unknown as ShareDto);
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("B");
  });

  it("image fails to load -> falls back to the initial", async () => {
    const { avatar } = await renderWith({ ...SHARE, avatar: REF });
    fireEvent.error(avatar.querySelector("img")!);
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("B");
  });
});
