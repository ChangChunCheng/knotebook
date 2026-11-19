import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LastEditedDto, NoteDto } from "@knotebook/shared";
import { OWNER_PERMS } from "@/test/fixtures";
import { patchNotesListLastEdited, useCreateNote, useDeleteNote, useNote, useNoteByGroupPath, useNoteByPath } from "./notes";

function note(id: string, lastEdited: LastEditedDto | null): NoteDto {
  return {
    id,
    title: `T-${id}`,
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: `s-${id}`,
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
  };
}

const OLD: LastEditedDto = { at: "2026-10-01T00:00:00.000Z", byHandle: "ann", agentLabel: null };
const NEW: LastEditedDto = { at: "2026-10-03T00:00:00.000Z", byHandle: "bob", agentLabel: "claude" };

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("patchNotesListLastEdited", () => {
  it("no [\"notes\"] cache: no cache entry is created", () => {
    const qc = client();
    patchNotesListLastEdited(qc, "a", NEW);
    expect(qc.getQueryData(["notes"])).toBeUndefined();
    expect(qc.getQueryCache().find({ queryKey: ["notes"] })).toBeUndefined();
  });

  it("row not in the list: nothing written", () => {
    const qc = client();
    qc.setQueryData(["notes"], [note("a", OLD), note("b", OLD)]);
    const spy = vi.spyOn(qc, "setQueryData");
    patchNotesListLastEdited(qc, "zzz", NEW);
    expect(spy).not.toHaveBeenCalled();
  });

  it("only that row's lastEdited is replaced, other row objects and order unchanged; null -> value is replaced too", () => {
    const qc = client();
    const prev = [note("a", OLD), note("b", OLD), note("c", null)];
    qc.setQueryData(["notes"], prev);
    patchNotesListLastEdited(qc, "b", NEW);
    const next = qc.getQueryData<NoteDto[]>(["notes"])!;
    expect(next.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(next[1]).toEqual({ ...prev[1], lastEdited: NEW });
    // Other rows keeping their references is guaranteed by TanStack's structural sharing, not asserted here.
    expect(next[0]).toEqual(prev[0]);
    expect(next[2]).toEqual(prev[2]);

    patchNotesListLastEdited(qc, "c", NEW);
    expect(qc.getQueryData<NoteDto[]>(["notes"])![2]).toEqual({ ...prev[2], lastEdited: NEW });

    // Same at but different agentLabel must also be written (equality compares all three fields).
    const relabeled: LastEditedDto = { ...NEW, agentLabel: "other" };
    patchNotesListLastEdited(qc, "c", relabeled);
    expect(qc.getQueryData<NoteDto[]>(["notes"])![2]!.lastEdited).toEqual(relabeled);
  });

  it("equal value (a different new object) or both null: not written", () => {
    const qc = client();
    qc.setQueryData(["notes"], [note("a", OLD), note("c", null)]);
    const spy = vi.spyOn(qc, "setQueryData");
    patchNotesListLastEdited(qc, "a", { ...OLD });
    patchNotesListLastEdited(qc, "c", null);
    expect(spy).not.toHaveBeenCalled();
  });

  it("an older value or null doesn't overwrite a newer value in the list", () => {
    const qc = client();
    qc.setQueryData(["notes"], [note("a", NEW)]);
    const spy = vi.spyOn(qc, "setQueryData");
    patchNotesListLastEdited(qc, "a", OLD);
    patchNotesListLastEdited(qc, "a", null);
    expect(spy).not.toHaveBeenCalled();
    expect(qc.getQueryData<NoteDto[]>(["notes"])![0]!.lastEdited).toEqual(NEW);
  });
});

describe("useDeleteNote", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("after moving to trash invalidates ['trash'], existing ['notes'] / ['note', id] / ['backlinks'] unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 204, json: () => Promise.reject(new Error("no body")) } as unknown as Response));
    const qc = client();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useDeleteNote(), { wrapper });
    await result.current.mutateAsync("a");
    const keys = spy.mock.calls.map(([arg]) => JSON.stringify(arg?.queryKey));
    expect([...keys].sort()).toEqual(['["backlinks"]', '["note","a"]', '["notes"]', '["trash"]']);
  });
});

describe("useCreateNote x folder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mutateAsync({ folderId }) -> POST /api/notes with body {\"folderId\":\"A\"}", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve({ id: "n1" }) } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const qc = client();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useCreateNote(), { wrapper });
    await result.current.mutateAsync({ folderId: "A" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/notes");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ folderId: "A" });
  });
});

describe("single-note query retry option (trash: resolver in_trash isn't retried)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const retryOf = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryCache().find({ queryKey: key })?.options.retry;

  it("retry not given -> keeps the QueryClient default (must not override with undefined, or query-core falls back to 3 retries); a given value is used", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const qc = client();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
    const custom = () => false;
    renderHook(
      () => {
        useNote("plain");
        useNote("custom", { retry: custom });
        useNoteByPath("h", "s", { retry: custom });
        useNoteByGroupPath("g", "s", { retry: custom });
      },
      { wrapper },
    );
    expect(retryOf(qc, ["note", "plain"])).toBe(false);
    expect(retryOf(qc, ["note", "custom"])).toBe(custom);
    expect(retryOf(qc, ["note-by-path", "h", "s"])).toBe(custom);
    expect(retryOf(qc, ["note-by-group-path", "g", "s"])).toBe(custom);
  });
});
