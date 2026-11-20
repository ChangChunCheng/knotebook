/**
 * Stubs global fetch (no hook mocks) so real react-query runs; stubFetch throws on unexpected URLs, so an extra API call from the component fails the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { AI_EDITS_RETENTION, avatarUrl, type NoteDto, type NoteEditDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { NOTE_EDITS_QUERY_KEY } from "@/api/noteEdits";
import { AiEditsDialog } from "./AiEditsDialog";
import { OWNER_PERMS } from "@/test/fixtures";

const NOTE: NoteDto = {
  id: "11111111-1111-4111-8111-111111111111",
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
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

const EDITS_URL = `/api/notes/${NOTE.id}/edits`;
const revertUrl = (editId: string) => `${EDITS_URL}/${editId}/revert`;

const E1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const E2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const E3 = "cccccccc-3333-4333-8333-cccccccccccc";
const E4 = "dddddddd-4444-4444-8444-dddddddddddd";

/** `ownerHandle` is `string | null` (null for group notes); `?? ""` only narrows the type for this personal note. */
function edit(patch: Partial<NoteEditDto> & { id: string }): NoteEditDto {
  return {
    op: "replace_section",
    sectionId: "sec-1",
    heading: "Section A",
    byHandle: NOTE.ownerHandle ?? "",
    agentLabel: "claude",
    avatar: null,
    createdAt: "2026-02-03T04:05:06.000Z",
    revertedAt: null,
    revertOf: null,
    revertable: false,
    ...patch,
  };
}

function tree(ui: React.ReactElement, queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        {ui}
        <Toaster />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(tree(ui, queryClient));
  return {
    queryClient,
    rerender: (next: React.ReactElement) => view.rerender(tree(next, queryClient)),
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown }) {
  const calls: Array<{ url: string; method: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), init });
      const { status, body } = handler(url, init);
      return { ok: status < 400, status, json: async () => body } as unknown as Response;
    }),
  );
  return calls;
}

const listBody = (edits: NoteEditDto[]) => ({ status: 200, body: { edits } });

describe("AiEditsDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("four states (#272): revertable row has a revert button; reverted row is marked reverted; revert record is marked revertRecord; other rows show why they cannot be reverted; one line under the list keeps the retained count", async () => {
    const edits = [
      edit({ id: E1, revertable: true }),
      edit({ id: E2, revertable: false, revertedAt: "2026-02-04T00:00:00.000Z", agentLabel: null }),
      edit({ id: E3, revertable: false }),
      edit({ id: E4, op: "revert", revertable: false, revertOf: E2 }),
    ];
    stubFetch((url) => {
      if (url === EDITS_URL) return listBody(edits);
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderWithQuery(<AiEditsDialog note={NOTE} open onOpenChange={vi.fn()} />);

    const third = await screen.findByTestId(`ai-edit-${E3}`);
    const reason = within(third).getByText("Can't revert: this content has changed since, or the note was switched to another version");
    expect(reason).toHaveClass("max-w-[14rem]", "text-right");
    expect(reason).not.toHaveClass("shrink-0");
    expect(within(third).queryByRole("button", { name: i18n.t("aiEdits.revert") })).toBeNull();

    const fourth = screen.getByTestId(`ai-edit-${E4}`);
    expect(within(fourth).getByText(i18n.t("aiEdits.revertRecord"))).toBeInTheDocument();
    expect(within(fourth).queryByText(i18n.t("aiEdits.stale"))).toBeNull();
    expect(within(fourth).queryByRole("button", { name: i18n.t("aiEdits.revert") })).toBeNull();

    expect(screen.getByText("Each note keeps up to its 100 most recent AI edits")).toBeInTheDocument();
    expect(AI_EDITS_RETENTION).toBe(100);

    const first = screen.getByTestId(`ai-edit-${E1}`);
    expect(within(first).getByRole("button", { name: i18n.t("aiEdits.revert") })).toBeInTheDocument();
    expect(within(first).getByTestId("ai-edit-who").textContent).toBe(`${NOTE.ownerHandle} (claude)`);
    expect(within(first).queryByText(i18n.t("aiEdits.reverted"))).toBeNull();

    const second = screen.getByTestId(`ai-edit-${E2}`);
    expect(within(second).getByText(i18n.t("aiEdits.reverted"))).toBeInTheDocument();
    expect(within(second).queryByText(i18n.t("aiEdits.revertRecord"))).toBeNull();
    expect(within(second).queryByRole("button", { name: i18n.t("aiEdits.revert") })).toBeNull();
    // agentLabel null = written by a human via cookie, so only the handle is shown.
    expect(within(second).getByTestId("ai-edit-who").textContent).toBe(NOTE.ownerHandle);
  });

  it("every row has the writer's avatar (agent rows show the owner's avatar, not an AI icon); avatar is not inside ai-edit-who; missing avatar field -> first letter", async () => {
    const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const legacy = edit({ id: E3, agentLabel: null });
    delete (legacy as { avatar?: unknown }).avatar;
    stubFetch((url) => {
      if (url === EDITS_URL) return listBody([edit({ id: E1, avatar: { id: ID, v: 4 } }), edit({ id: E2, agentLabel: null, avatar: null }), legacy]);
      throw new Error(`unexpected fetch: ${url}`);
    });
    renderWithQuery(<AiEditsDialog note={NOTE} open onOpenChange={vi.fn()} />);

    const first = await screen.findByTestId(`ai-edit-${E1}`);
    const img = first.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(avatarUrl(ID, 4));
    expect(first.querySelector("svg")).toBeNull();
    const who = within(first).getByTestId("ai-edit-who");
    expect(who.querySelector("img")).toBeNull();
    expect(who.contains(img)).toBe(false);
    expect(who.textContent).toBe(`${NOTE.ownerHandle} (claude)`);

    for (const id of [E2, E3]) {
      const row = screen.getByTestId(`ai-edit-${id}`);
      expect(row.querySelector("img")).toBeNull();
      expect(row.querySelector("[aria-hidden='true']")!.textContent).toBe("T");
    }
  });

  it("#272: empty list -> only the 'none yet' line, no retained-count line", async () => {
    stubFetch((url) => {
      if (url === EDITS_URL) return listBody([]);
      throw new Error(`unexpected fetch: ${url}`);
    });
    renderWithQuery(<AiEditsDialog note={NOTE} open onOpenChange={vi.fn()} />);
    expect(await screen.findByText(i18n.t("aiEdits.empty"))).toBeInTheDocument();
    expect(screen.queryByText(/most recent AI edits/)).toBeNull();
  });

  it("revert: 409 stale -> errors.stale toast and no list refetch; success -> list refetch, three note queries invalidated, revertOk toast", async () => {
    const edits = [edit({ id: E1, revertable: true }), edit({ id: E2, revertable: true })];
    const calls = stubFetch((url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === EDITS_URL && method === "GET") return listBody(edits);
      if (url === revertUrl(E1) && method === "POST") {
        return { status: 409, body: { error: { code: "stale", message: "x" } } };
      }
      if (url === revertUrl(E2) && method === "POST") {
        return { status: 201, body: { editId: "new", fingerprint: "f", outline: [] } };
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const { queryClient } = renderWithQuery(<AiEditsDialog note={NOTE} open onOpenChange={vi.fn()} />);
    // Seed these keys first (the targets of `invalidateNoteQueries`): `isInvalidated` can only observe keys already in the cache.
    queryClient.setQueryData(["note", NOTE.id], NOTE);
    queryClient.setQueryData(["note-by-path", NOTE.ownerHandle, NOTE.slug], NOTE);

    const first = await screen.findByTestId(`ai-edit-${E1}`);
    // The list lives under `NOTE_EDITS_QUERY_KEY(noteId)`; if the hook changed keys this would be undefined.
    expect(queryClient.getQueryState(NOTE_EDITS_QUERY_KEY(NOTE.id))?.data).toHaveLength(2);
    fireEvent.click(within(first).getByRole("button", { name: i18n.t("aiEdits.revert") }));

    await screen.findByText(i18n.t("errors.stale"));
    expect(screen.queryByText(i18n.t("aiEdits.revertOk"))).toBeNull();
    expect(calls.filter((c) => c.url === EDITS_URL && c.method === "GET")).toHaveLength(1);
    expect(queryClient.getQueryState(["note-by-path", NOTE.ownerHandle, NOTE.slug])?.isInvalidated).toBe(false);

    const second = screen.getByTestId(`ai-edit-${E2}`);
    fireEvent.click(within(second).getByRole("button", { name: i18n.t("aiEdits.revert") }));

    await screen.findByText(i18n.t("aiEdits.revertOk"));
    await waitFor(() =>
      expect(calls.filter((c) => c.url === EDITS_URL && c.method === "GET").length).toBeGreaterThan(1),
    );
    await waitFor(() => {
      expect(queryClient.getQueryState(["note", NOTE.id])?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(["note-by-path", NOTE.ownerHandle, NOTE.slug])?.isInvalidated).toBe(true);
    });
  });

  it("no request while the dialog is closed; opening makes exactly one GET /edits", async () => {
    const calls = stubFetch((url) => {
      if (url === EDITS_URL) return listBody([]);
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { rerender } = renderWithQuery(<AiEditsDialog note={NOTE} open={false} onOpenChange={vi.fn()} />);
    // Yield a macrotask so react-query can schedule the fetch; a synchronous assertion would pass vacuously.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(0);

    rerender(<AiEditsDialog note={NOTE} open onOpenChange={vi.fn()} />);
    await waitFor(() => expect(calls.map((c) => c.url)).toEqual([EDITS_URL]));
    expect(await screen.findByText(i18n.t("aiEdits.empty"))).toBeInTheDocument();
  });
});
