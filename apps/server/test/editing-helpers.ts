// Shared seams for integration tests of the content endpoints (`GET /api/notes/:id/content`, plus the write side since #137).
// Kept apart from `test/helpers.ts` (the repo-wide harness) because this one serves only the editing/content family and needs a "token for a given user" -
// `seedToken` in `api-token-auth.test.ts` creates its own user and doesn't fit.
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import { YDOC_FRAGMENT, type TokenScope } from "@knotebook/shared";
import { generateAccessToken, hashToken } from "../src/auth/api-token.js";
import { apiTokens } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { testEditingRuntime, type CollabTestCtx, type HttpSession, type TestClient } from "./helpers.js";

export async function seedTokenForUser(
  db: Db,
  userId: string,
  scope: TokenScope = "notes:read notes:write",
  name = "test"
): Promise<{ token: string; tokenId: string }> {
  const token = generateAccessToken();
  const [row] = await db
    .insert(apiTokens)
    .values({ userId, kind: "pat", name, scope, accessTokenHash: hashToken(token), accessExpiresAt: null })
    .returning();
  return { token, tokenId: row!.id };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export function getContent(app: FastifyInstance, noteId: string, token: string, section?: string) {
  return app.inject({
    method: "GET",
    url: `/api/notes/${noteId}/content${section ? `?section=${encodeURIComponent(section)}` : ""}`,
    headers: bearer(token),
  });
}

/** Writes markdown into a note through a provider connection + a server-side EditorSession, **and returns only after the server really received it**. */
export async function seedContent(ctx: CollabTestCtx, session: HttpSession, noteId: string, markdown: string): Promise<TestClient> {
  const client = await session.connect(noteId);
  const s = await EditorSession.open(testEditingRuntime, client.doc);
  try {
    s.editor.replaceBlocks(s.editor.document, s.editor.tryParseMarkdownToBlocks(markdown));
  } finally {
    s.close(); // lease of the module-level singleton runtime, must be returned even on throw
  }
  // The sentinel is the visible text of the markdown's last line (a heading's `#` prefix doesn't enter the XML text, so it is stripped). The last line is used
  // because Yjs updates arrive as a whole batch, so the last line arriving means the whole batch did.
  //
  // **The sentinel must be visible text that appears in the XML string and must identify this seed uniquely.** Both preconditions have a trap,
  // and the seed string is the **caller's** responsibility (nothing here can or should fix it):
  //
  // (1) `docText()` goes through `fragment.toString()` - only a block's **text and attribute values** enter it. Lines such as `![caption](/api/uploads/x)`, `---` and fenced code
  //     are parsed into **non-text blocks** (an image stores `url="..."`-style attributes), so that markdown syntax itself never appears in the string.
  //     If the seed ends with such a line, this `waitFor` runs the full 5 seconds and throws a timeout. **Fix: append a line of visible text at the tail of such fixtures**
  //     (the image fixture does this - see the "note with an uploaded image" case in `note-edits.test.ts`).
  //     **Never change this wait**: making it "skip if not found" or shortening the timeout removes the premise of about 25 "seed, then disconnect immediately" cases across the file,
  //     and **silently** (the symptom is content mysteriously missing); removing the wait is a mutation no test catches.
  //
  // (2) Attribute names themselves contain common ASCII characters (`textColor` contains `x`, `t`, `e`...), so a **single-character ASCII sentinel is as good as no wait**:
  //     it matches as soon as the update normalizing the empty document arrives, without verifying the seed arrived. Write seeds long/distinctive enough.
  //     (A single CJK character has no such problem: attribute names and block ids are ASCII.)
  const sentinel = markdown.split("\n").map(l => l.trim().replace(/^#+\s*/, "")).filter(Boolean).at(-1) ?? "";
  if (sentinel) {
    await waitFor(`server 收到種子內容（${sentinel}）`, 5_000, () =>
      docText(ctx.collab.hocuspocus.documents.get(noteId)!).includes(sentinel)
    );
  }
  return client;
}

export function docText(doc: Y.Doc): string {
  return doc.getXmlFragment(YDOC_FRAGMENT).toString();
}

export async function waitFor(label: string, ms: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`等待逾時（${ms}ms）：${label}`);
}

export const tick = () => new Promise<void>(r => setImmediate(r));
