import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT, type NoteDto, type UserDto, type VersionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import type { CollabState } from "@/collab/connection";
import { ThemeProvider } from "@/theme";
import { ActiveNoteProvider } from "@/lib/active-note";
import { AppShellLayout } from "@/components/AppShellLayout";
import { OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { stubLayoutTier } from "@/test/layout-tier";
import { vid, vrow } from "@/test/version-fixtures";
import { fieldView, stubLayout } from "@/components/knowledge/test-support";

// The editor is a stand-in (as in NotePage.test.tsx): the narrow-screen version sheet is NotePage's own child, a sibling of the editor.
vi.mock("@/components/NoteEditor", async () => {
  const { useVersions } = await import("@/lib/versions-context");
  function NoteEditorMock({ headerSlot }: { headerSlot?: React.ReactNode }) {
    const versions = useVersions();
    return (
      <div data-testid="note-editor">
        {headerSlot}
        <button type="button" onClick={() => versions.open()}>
          mock-open-versions
        </button>
      </div>
    );
  }
  return { NoteEditor: NoteEditorMock };
});

vi.mock("@/lib/use-container-width", () => ({ useContainerWidth: () => 600 }));

const collab = vi.hoisted(() => ({ doc: undefined as unknown as Y.Doc, state: { phase: "connected", role: "owner" } as CollabState }));
vi.mock("@/collab/useCollab", () => ({
  useCollab: ({ noteId }: { noteId: string | undefined }) => ({
    state: collab.state,
    doc: collab.doc,
    provider: { synced: true, on: () => {}, off: () => {} },
    synced: true,
    syncedFor: noteId ?? null,
  }),
}));

const { default: NotePage } = await import("./NotePage");

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

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "My Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
  slugIsCustom: true,
  prevSlug: null,
  ownerHandle: "alice",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

const VERSION: VersionDto = { id: vid(1), seq: 1, kind: "manual", name: null, editors: [], baseSeq: null, base: null, createdAt: "2026-01-01T00:00:00.000Z" };

function b64(blocks: unknown[]): string {
  const doc = new Y.Doc();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PartialBlock generic triple
  blocksToYXmlFragment(BlockNoteEditor.create({ schema: noteSchema }), blocks as any, doc.getXmlFragment(YDOC_FRAGMENT));
  return btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc)));
}

const SNAPSHOT = [
  {
    id: "H1",
    type: "heading",
    props: { level: 1, knowledgeId: "k_00000001", knowledgeWhen: "when alice", knowledgeConclusion: "conclusion bob", knowledgeVerified: "2026-10-01", knowledgeStatus: "verified" },
    content: "Title H1",
  },
  { id: "P", type: "paragraph", content: "text" },
];

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

function stubFetch() {
  const fields = { fields: fieldView({ off: ["when"] }).fields };
  const versions = `/api/notes/${NOTE.id}/versions`;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET") return json({}, 204);
      if (url === "/api/auth/me") return json(USER);
      if (url === "/api/auth/config") return json({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true });
      if (url === "/api/groups" || url === "/api/favorites" || url === "/api/notes") return json([]);
      if (url === "/api/folders") return json(FOLDER_LIST_EMPTY);
      if (url === `/api/knowledge/fields?note=${NOTE.id}`) return json(fields);
      if (url === `${versions}?limit=50` || url === `${versions}?limit=1`) {
        return json({ versions: [VERSION], current: { baseSeq: 1, base: { id: VERSION.id, name: null, deleted: false }, dirty: false, nextSeq: 2, autoEnabled: true }, nextBefore: null });
      }
      if (url === `${versions}/1`) return json({ id: VERSION.id, seq: 1, ydoc: b64(SNAPSHOT) });
      if (url.endsWith("/backlinks")) return json({ backlinks: [] });
      if (url.startsWith("/api/notes/") && !url.slice("/api/notes/".length).includes("/")) return json(NOTE);
      return json({ error: { code: "not_found", message: "Not found" } }, 404);
    }),
  );
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/notes/my-note"]}>
          <ActiveNoteProvider>
            <Routes>
              <Route element={<AppShellLayout />}>
                <Route path="/notes/:ref" element={<NotePage />} />
                <Route path="/n/:handle/:slug" element={<NotePage />} />
              </Route>
            </Routes>
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("NotePage knowledge field settings", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    collab.doc = new Y.Doc();
    stubLayoutTier("phone");
    stubLayout();
    stubFetch();
  });
  afterEach(() => {
    collab.doc.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("the narrow-screen version sheet shows the card's enabled fields", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "mock-open-versions" }));
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: vrow(1) }));
    const single = await within(sheet).findByTestId("diff-single");
    const icon = await waitFor(() => {
      const found = single.querySelector<HTMLElement>("[data-kb-knowledge-icon]");
      expect(found).not.toBeNull();
      return found!;
    });
    fireEvent.click(icon);
    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-kb-knowledge-card]");
      expect(found).not.toBeNull();
      return found!;
    });
    await waitFor(() => expect(within(card).getByText("Conclusion")).toBeInTheDocument());
    expect(within(card).getByText("conclusion bob")).toBeInTheDocument();
    expect(within(card).queryByText("When to read")).toBeNull();
    expect(within(card).queryByText("when alice")).toBeNull();
  });
});
