// 讀路徑 markdown 的 golden（spec §11.2 末段、§13.1）：同一份 blocks 在 server 與 web（PR-2 Task 5）讀出逐位元組相同。
// 輸入一律先寫進編輯器，再拿 `ed.document`（完整 blocks，與真實讀路徑同形）去序列化——external HTML 的 data-* 順序跟著 props 鍵序走。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { blocksToNoteMarkdown } from "@knotebook/shared";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" }); rt.installGlobals();
type Ed = EditorSession["editor"];

// ⚠ 同 editing-colors.test.ts：每一處 open 都 `try/finally close()`（lease 不變量）。
const withSession = async <T>(fn: (ed: Ed) => T, doc = new Y.Doc()): Promise<T> => {
  const s = await EditorSession.open(rt, doc);
  try {
    return fn(s.editor);
  } finally {
    s.close();
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組
type AnyBlocks = any[];
const docWith = async (blocks: AnyBlocks): Promise<Y.Doc> => {
  const doc = new Y.Doc();
  await withSession(ed => {
    ed.replaceBlocks(ed.document, blocks);
  }, doc);
  return doc;
};

type GoldenCase = { id: string; roundTrip: string; note?: string; blocks: AnyBlocks; markdown: string };
const goldens = JSON.parse(readFileSync(new URL("../../../../packages/shared/test-fixtures/note-markdown-goldens.json", import.meta.url), "utf8")) as { cases: GoldenCase[] };

describe("note-markdown goldens（讀出）", () => {
  it("id 不重複", () => {
    const ids = goldens.cases.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(goldens.cases.map(c => [c.id, c] as const))("%s", async (_id, c) => {
    const doc = await docWith(c.blocks);
    const md = await withSession(ed => blocksToNoteMarkdown(ed, ed.document), doc);
    expect(md, `${c.id} 實際：${JSON.stringify(md)}`).toBe(c.markdown);
  });
});
