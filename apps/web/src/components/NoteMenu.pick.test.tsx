// `handlePick` must explicitly decide "move within the same space"; it can't treat any null from `transferTargetOf` as a same-space move and PUT.
// In the real menu, groups and `DestSpace` come from the same `pick.groups`, so the UI can't produce "destination group not in pick.groups";
// hence this only swaps `GroupTransferMenuItems` for one button that feeds a crafted pick directly; everything else (NoteMenu, handlePick, transferTargetOf) is real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { groupDto, memberRole, OWNER_PERMS } from "@/test/fixtures";
import { indexFolders } from "@/components/sidebar/folder-index";
import { NoteMenu } from "@/components/NoteMenu";
import type { DestinationPick } from "@/components/share/GroupTransfer";

const picks: { current: DestinationPick | null } = { current: null };

vi.mock("@/components/share/GroupTransfer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/share/GroupTransfer")>();
  return {
    ...actual,
    GroupTransferMenuItems: ({ onPick }: { onPick: (pick: DestinationPick) => void }) => (
      <button
        type="button"
        onClick={() => {
          if (picks.current !== null) onPick(picks.current);
        }}
      >
        fake-pick
      </button>
    ),
  };
});

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
const KNOWN = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Known" }, memberRole());
const MISSING_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

let fetchMock: ReturnType<typeof vi.fn>;

function renderMenu(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NoteMenu note={NOTE} state={{ phase: "connected", role: "owner" }} leavingRef={{ current: false }} onOpenEdits={() => {}} />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function pickIt(pick: DestinationPick): Promise<void> {
  picks.current = pick;
  fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), { button: 0 });
  fireEvent.click(await screen.findByRole("button", { name: "fake-pick" }));
}

const writes = () => fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase() !== "GET");

describe("NoteMenu handlePick: same-space moves are decided explicitly", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT") {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ...NOTE, folderId: null }) } as unknown as Response);
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) } as unknown as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    picks.current = null;
  });

  it("personal note moved to a group not in pick.groups -> no PUT, no confirm dialog", async () => {
    renderMenu();
    await pickIt({
      kind: "move",
      target: { kind: "place", space: { kind: "group", groupId: MISSING_ID, name: "Gone" }, folder: null },
      groups: [KNOWN],
      index: indexFolders([]),
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "fake-pick" })).toBeNull());
    expect(writes()).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("contrast: personal note moved to My notes (same space) -> PUT directly, no confirm dialog", async () => {
    renderMenu();
    await pickIt({
      kind: "move",
      target: { kind: "place", space: { kind: "personal" }, folder: null },
      groups: [KNOWN],
      index: indexFolders([]),
    });
    await waitFor(() => expect(writes().length).toBe(1));
    expect(String(writes()[0]?.[0])).toBe(`/api/notes/${NOTE.id}/folder`);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
