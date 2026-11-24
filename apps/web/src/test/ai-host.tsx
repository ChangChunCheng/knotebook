import type { ReactNode } from "react";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { BlockNoteEditor, getNodeById } from "@blocknote/core";
import { AI_SSE_EVENTS, DEFAULT_KNOWLEDGE_FIELD_VIEW, type AiActionDto, type KnowledgeFieldView, type KnowledgeFieldsDto, type NoteDto } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { AiSessionProvider } from "@/components/ai/AiSession";
import { KnowledgeFieldsContext, KnowledgeFieldsProvider, type KnowledgeFieldsValue } from "@/components/knowledge/fields-context";
import { NoteEditorView } from "@/components/NoteEditor";
import { Toaster } from "@/components/ui/toast";
import { ThemeProvider } from "@/theme";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

/**
 * Shared Host for the AI box tests: follows the real mount chain in `NoteEditor.tsx` - the knowledge fields provider wraps
 * `AiSessionProvider`, `AiSessionProvider` wraps `NoteEditorView`, the AI components are children of `<BlockNoteView>`, and `editor.portalElement`
 * is attached by BlockNoteView. Outer `MemoryRouter` + `QueryClientProvider`: the wikilink inline uses `useNavigate` / `useNotes`; `ThemeProvider`: the preview's `DiffEditor` uses `useTheme`.
 * It isn't `NoteEditor` itself - `NoteEditor` builds its editor with `useCreateBlockNote`, so tests can't get the instance to set a selection.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple; any per repo convention
export type AnyEditor = BlockNoteEditor<any, any, any>;

export function createTestEditor(initialContent: unknown[]): AnyEditor {
  return BlockNoteEditor.create({ schema: noteSchema, initialContent: initialContent as never }) as AnyEditor;
}

export interface AiRequestBody {
  action_id: string;
  note_id: string;
  text: string;
  instruction?: string;
  focus?: string;
}

export interface AiCall {
  body: AiRequestBody;
  signal: AbortSignal;
  delta(text: string): void;
  done(): void;
  fail(code: string): void;
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), body: null } as unknown as Response;
}

/** `knowledgeFields`: what `GET /api/knowledge/fields?note=…` serves to a host rendered with `knowledgeFields: "fetch"`. */
export function stubAiFetch(opts: { actions: AiActionDto[]; notes?: NoteDto[]; knowledgeFields?: KnowledgeFieldView }): { calls: AiCall[] } {
  const calls: AiCall[] = [];
  const encoder = new TextEncoder();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") return Promise.resolve(jsonResponse(200, { actions: opts.actions }));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(jsonResponse(200, opts.notes ?? []));
      if (url.startsWith("/api/knowledge/fields?note=") && method === "GET") {
        const dto: KnowledgeFieldsDto = { fields: (opts.knowledgeFields ?? DEFAULT_KNOWLEDGE_FIELD_VIEW).fields };
        return Promise.resolve(jsonResponse(200, dto));
      }
      if (url === "/api/ai" && method === "POST") {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        });
        const frame = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        calls.push({
          body: JSON.parse(String(init?.body)) as AiRequestBody,
          signal: init?.signal as AbortSignal,
          delta: (text) => frame(AI_SSE_EVENTS.delta, { text }),
          done: () => {
            frame(AI_SSE_EVENTS.done, {});
            controller.close();
          },
          fail: (code) => {
            frame(AI_SSE_EVENTS.error, { code, message: "test failure" });
            controller.close();
          },
        });
        return Promise.resolve({ ok: true, status: 200, body: stream, json: () => Promise.reject(new Error("stream")) } as unknown as Response);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return { calls };
}

export interface AiHostProps {
  editor: AnyEditor;
  noteId?: string;
  editable?: boolean;
  onAutoClose?: () => void;
  sizeGuard?: (incomingBytes: number) => boolean;
  /** Defaults to the built-in fields, ready. `"fetch"` mounts the real provider, which loads them through `stubAiFetch`. */
  knowledgeFields?: KnowledgeFieldsValue | "fetch";
  children?: ReactNode;
}

const READY_FIELDS: KnowledgeFieldsValue = { view: DEFAULT_KNOWLEDGE_FIELD_VIEW, status: "ready" };

function FieldsLayer({ noteId, fields, children }: { noteId: string; fields: AiHostProps["knowledgeFields"]; children: ReactNode }) {
  if (fields === "fetch") return <KnowledgeFieldsProvider noteId={noteId}>{children}</KnowledgeFieldsProvider>;
  return <KnowledgeFieldsContext.Provider value={fields ?? READY_FIELDS}>{children}</KnowledgeFieldsContext.Provider>;
}

async function noItems(): Promise<never[]> {
  return [];
}

export function renderAiHost(props: AiHostProps) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (p: AiHostProps) => (
    <MemoryRouter>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <FieldsLayer noteId={p.noteId ?? "note-1"} fields={p.knowledgeFields}>
            <AiSessionProvider editor={p.editor} noteId={p.noteId ?? "note-1"} editable={p.editable ?? true} onAutoClose={p.onAutoClose} sizeGuard={p.sizeGuard}>
              <NoteEditorView
                editor={p.editor}
                editable={p.editable ?? true}
                theme="light"
                noteId={p.noteId ?? "note-1"}
                getItems={noItems}
                getSlashItems={noItems}
              >
                {p.children}
              </NoteEditorView>
            </AiSessionProvider>
          </FieldsLayer>
          <Toaster />
        </QueryClientProvider>
      </ThemeProvider>
    </MemoryRouter>
  );
  const result = render(tree(props));
  return { ...result, queryClient, rerenderHost: (overrides: Partial<AiHostProps>) => result.rerender(tree({ ...props, ...overrides })) };
}

export function contentStart(editor: AnyEditor, blockId: string): number {
  const info = getNodeById(blockId, editor.prosemirrorState.doc);
  if (!info) throw new Error(`找不到區塊 ${blockId}`);
  return info.posBeforeNode + 2;
}

export function contentEnd(editor: AnyEditor, blockId: string): number {
  const info = getNodeById(blockId, editor.prosemirrorState.doc);
  if (!info) throw new Error(`找不到區塊 ${blockId}`);
  return info.posBeforeNode + 2 + (info.node.firstChild?.content.size ?? 0);
}

export function selectText(editor: AnyEditor, from: number, to: number): void {
  act(() => {
    editor._tiptapEditor.commands.setTextSelection({ from, to });
  });
}

export function selectInBlock(editor: AnyEditor, blockId: string, start: number, end: number): void {
  const base = contentStart(editor, blockId);
  selectText(editor, base + start, base + end);
}

export function selectWholeBlocks(editor: AnyEditor, firstId: string, lastId: string): void {
  selectText(editor, contentStart(editor, firstId), contentEnd(editor, lastId));
}

export function placeCursor(editor: AnyEditor, blockId: string, offset: number): void {
  const pos = contentStart(editor, blockId) + offset;
  selectText(editor, pos, pos);
}
