import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { Toaster } from "@/components/ui/toast";
import { TITLE_DEBOUNCE_MS, TitleInput } from "./TitleInput";
import { OWNER_PERMS } from "@/test/fixtures";

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
  title: "Old title",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "old-title",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

function renderTitle(
  props: Partial<{ note: NoteDto; readOnly: boolean; isNavigatingAway: () => boolean }> = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TitleInput
        note={props.note ?? NOTE}
        readOnly={props.readOnly ?? false}
        isNavigatingAway={props.isNavigatingAway}
      />
      <Toaster />
    </QueryClientProvider>,
  );
  return queryClient;
}

/** PATCH response: the server returns the whole updated NoteDto. Keeps the original slug by default (most cases ignore the URL);
 * cases covering a title change -> auto slug recompute pass a new slug (the real server always recomputes for slugIsCustom=false; the stub doesn't simulate it). */
function patchOk(title: string, slug: string = NOTE.slug) {
  return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ ...NOTE, title, slug }) });
}

describe("TitleInput", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.replaceState(null, "", "/notes/old-title-11111111-1111-1111-1111-111111111111");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("PATCHes the new title after the 800ms debounce", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(patchOk("New title")));
    vi.stubGlobal("fetch", fetchMock);

    renderTitle();
    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "New title" } });

    act(() => void vi.advanceTimersByTime(TITLE_DEBOUNCE_MS - 50));
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(60));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/notes/${NOTE.id}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ title: "New title" });
  });

  it("sends only the last value: continuous typing does not PATCH per keystroke", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(patchOk("abc")));
    vi.stubGlobal("fetch", fetchMock);

    renderTitle();
    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "a" } });
    act(() => void vi.advanceTimersByTime(200));
    fireEvent.change(input, { target: { value: "ab" } });
    act(() => void vi.advanceTimersByTime(200));
    fireEvent.change(input, { target: { value: "abc" } });
    act(() => void vi.advanceTimersByTime(TITLE_DEBOUNCE_MS + 10));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({
      title: "abc",
    });
  });

  it("blur flushes the pending change immediately without waiting for the timer", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(patchOk("Blurred")));
    vi.stubGlobal("fetch", fetchMock);

    renderTitle();
    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "Blurred" } });
    fireEvent.blur(input);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => void vi.advanceTimersByTime(TITLE_DEBOUNCE_MS + 100));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("writes the response into the ['note', note.id] cache and leaves the URL alone (convergence belongs to the NotePage effect)", async () => {
    // Coverage of the URL update after a save moved to the NotePage convergence-effect tests (NotePage.test.tsx); since #179 the
    // convergence goes through router navigate. This file mounts no router: switching the component to useNavigate would throw, so only window.history is guarded here.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(patchOk("Brand New", "brand-new"))),
    );
    const before = window.location.pathname;

    const queryClient = renderTitle();
    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "Brand New" } });
    fireEvent.blur(screen.getByLabelText("Note title"));

    await waitFor(() => expect(queryClient.getQueryData<NoteDto>(["note", NOTE.id])?.title).toBe("Brand New"));
    expect(window.location.pathname).toBe(before);
  });

  it("does not PATCH when the title did not actually change", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(patchOk(NOTE.title)));
    vi.stubGlobal("fetch", fetchMock);

    renderTitle();
    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: `  ${NOTE.title}  ` } });
    fireEvent.blur(input);

    act(() => void vi.advanceTimersByTime(TITLE_DEBOUNCE_MS + 100));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clearing the title then blur does not PATCH (server requires min(1)) and restores the original title", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(patchOk(NOTE.title)));
    vi.stubGlobal("fetch", fetchMock);

    renderTitle();
    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);

    act(() => void vi.advanceTimersByTime(TITLE_DEBOUNCE_MS + 100));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(input).toHaveValue(NOTE.title);
  });

  it("PATCH failure shows a toast with the matching error and restores the input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          fakeResponse({
            ok: false,
            status: 403,
            json: () => Promise.resolve({ error: { code: "forbidden", message: "nope" } }),
          }),
        ),
      ),
    );

    renderTitle();
    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByText("You don't have permission to do that.")).toBeInTheDocument());
    expect(input).toHaveValue(NOTE.title);
  });

  /** PATCH left in flight after submit: returns a function that lets the request land, so tests can type during the round trip. */
  function pendingPatch() {
    let settle!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (settle = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    return {
      fetchMock,
      settle: (response: Response) => settle(response),
    };
  }

  it("PATCH failure: text typed during the round trip is not overwritten by the restore", async () => {
    const { fetchMock, settle } = pendingPatch();

    renderTitle();
    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.blur(input);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(input, { target: { value: "Still typing" } });
    settle(
      fakeResponse({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: { code: "forbidden", message: "nope" } }),
      }),
    );

    await waitFor(() => expect(screen.getByText("You don't have permission to do that.")).toBeInTheDocument());
    expect(input).toHaveValue("Still typing");
  });

  it("PATCH success: text typed during the round trip is not overwritten by the server response", async () => {
    const { fetchMock, settle } = pendingPatch();

    const queryClient = renderTitle();
    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "Saved" } });
    fireEvent.blur(input);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(input, { target: { value: "Saved and more" } });
    settle(patchOk("Saved", "saved"));

    // Completion signal is the cache write-back (the last step of response handling, so the whole success path has run);
    // a synchronous assertion would run before the settle microtask chain and pass vacuously.
    await waitFor(() => expect(queryClient.getQueryData<NoteDto>(["note", NOTE.id])?.title).toBe("Saved"));
    expect(input).toHaveValue("Saved and more");
  });

  // Navigation gap: the URL already points at another note while this one is still on screen. Input typed in the gap is ignored, otherwise blur/debounce would save it into this note.
  it("ignores input while isNavigatingAway() is true: value unchanged, neither blur nor debounce sends a PATCH", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(patchOk("Typed in the gap")));
    vi.stubGlobal("fetch", fetchMock);

    renderTitle({ isNavigatingAway: () => true });
    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "Typed in the gap" } });
    expect(input).toHaveValue(NOTE.title);
    fireEvent.blur(input);

    act(() => void vi.advanceTimersByTime(TITLE_DEBOUNCE_MS + 100));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("text typed before the gap is still saved to this note on blur (it was typed on this note)", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(patchOk("Typed before")));
    vi.stubGlobal("fetch", fetchMock);
    let away = false;

    renderTitle({ isNavigatingAway: () => away });
    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "Typed before" } });
    away = true;
    fireEvent.blur(input);

    // Sent before the debounce expires: blur flushes it, the timer does not.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: TITLE_DEBOUNCE_MS / 2 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/notes/${NOTE.id}`);
    expect(JSON.parse(String(init.body))).toEqual({ title: "Typed before" });
  });

  it("readOnly (viewer) renders plain text without an input", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("should not fetch"))),
    );

    renderTitle({ readOnly: true });

    expect(screen.queryByLabelText("Note title")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: NOTE.title })).toBeInTheDocument();
  });

  // Shrink contract, asserted on the class: jsdom has no layout, so 64px cannot be measured. The viewer header's badge text is the longest;
  // the title must not fall back to min-w-0 (it would be squeezed to almost 0 before the label truncates).
  it("readOnly <h1> carries the min-w-16 shrink floor (class contract)", () => {
    renderTitle({ readOnly: true });
    expect(screen.getByRole("heading", { name: NOTE.title })).toHaveClass("min-w-16");
  });

  it("external title changes (made by someone else) sync into the input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("should not fetch"))),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <TitleInput note={NOTE} readOnly={false} />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("Note title")).toHaveValue("Old title");

    rerender(
      <QueryClientProvider client={queryClient}>
        <TitleInput note={{ ...NOTE, title: "Changed elsewhere" }} readOnly={false} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Changed elsewhere"));
  });
});
