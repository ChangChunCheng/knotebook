import { useContext, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { isKnowledgeFieldEnabled } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { fieldView } from "@/components/knowledge/test-support";
import type { KnowledgeFieldsValue } from "@/components/knowledge/fields-context";

const seen = vi.hoisted(() => ({ values: [] as KnowledgeFieldsValue[] }));

// Wraps rather than replaces: NoteEditor always renders SelectionAiController, which needs the real provider.
vi.mock("@/components/ai/AiSession", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/components/ai/AiSession")>();
  const { KnowledgeFieldsContext } = await import("@/components/knowledge/fields-context");
  function RecordingAiSessionProvider(props: Parameters<typeof m.AiSessionProvider>[0]) {
    seen.values.push(useContext(KnowledgeFieldsContext));
    return <m.AiSessionProvider {...props} />;
  }
  return { ...m, AiSessionProvider: RecordingAiSessionProvider };
});

const { NoteEditor } = await import("./NoteEditor");

const NOTE_ID = "note-1";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function stubFetch() {
  const fields = { fields: fieldView({ off: ["when"] }).fields };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") return Promise.resolve(json({ actions: [] }));
      if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(json([]));
      if (url === `/api/knowledge/fields?note=${NOTE_ID}`) return Promise.resolve(json(fields));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function Host({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}

describe("NoteEditor knowledge field settings", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    seen.values = [];
    stubFetch();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("code inside the AI session provider reads the note's fields, not the default", async () => {
    const doc = new Y.Doc();
    render(
      <Host>
        <NoteEditor doc={doc} provider={{ awareness: null } as never} editable user={{ id: "u1", name: "Alice" }} noteId={NOTE_ID} />
      </Host>,
    );
    await screen.findByTestId("note-editor");
    expect(seen.values[0]!.status).toBe("loading");
    // Inside AiSessionProvider it would stay at the context default, "loading", for good.
    await waitFor(() => {
      const last = seen.values.at(-1)!;
      expect(last.status).toBe("ready");
      expect(isKnowledgeFieldEnabled(last.view, "when")).toBe(false);
    });
    doc.destroy();
  });
});
