import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { EMPTY_YDOC_UPDATE_B64 } from "@knotebook/shared";
import { isPublicSharePath, isValidPublicToken, redactPublicTokens } from "../../src/routes/public.js";

describe("pure functions for public sharing (#72)", () => {
  it("EMPTY_YDOC_UPDATE_B64 really equals the update encoding of an empty Y.Doc (not a tautology where both ends import the same wrong value)", () => {
    const empty = Y.encodeStateAsUpdate(new Y.Doc());
    expect(Buffer.from(empty).toString("base64")).toBe(EMPTY_YDOC_UPDATE_B64);
    // and the client's applyUpdate accepts it without throwing (a zero-length update throws, which is why the constant exists).
    expect(() => Y.applyUpdate(new Y.Doc(), Buffer.from(EMPTY_YDOC_UPDATE_B64, "base64"))).not.toThrow();
  });

  it("isValidPublicToken: only a 43-char base64url passes; too long, too short, illegal characters and empty are all rejected", () => {
    expect(isValidPublicToken("A".repeat(43))).toBe(true);
    expect(isValidPublicToken("abc-DEF_0123456789012345678901234567890123R")).toBe(true);
    expect(isValidPublicToken("A".repeat(42))).toBe(false);
    expect(isValidPublicToken("A".repeat(44))).toBe(false);
    expect(isValidPublicToken("A".repeat(200))).toBe(false);
    expect(isValidPublicToken("!".repeat(43))).toBe(false);
    expect(isValidPublicToken("A".repeat(42) + "=")).toBe(false); // base64 (padding) is not base64url
    expect(isValidPublicToken("")).toBe(false);
  });

  it("redactPublicTokens: the token segment after /p/ and /api/public/notes/ becomes :token; the rest of the URL is unchanged", () => {
    const t = "A".repeat(43);
    expect(redactPublicTokens(`/p/${t}`)).toBe("/p/:token");
    expect(redactPublicTokens(`/p/${t}?x=1`)).toBe("/p/:token?x=1");
    expect(redactPublicTokens(`/api/public/notes/${t}`)).toBe("/api/public/notes/:token");
    expect(redactPublicTokens(`/api/public/notes/${t}/uploads/abc`)).toBe("/api/public/notes/:token/uploads/abc");
    // segments that are not 43 chars are masked too (log masking errs on the wide side: a token off by one character is not left in the clear)
    expect(redactPublicTokens("/p/short")).toBe("/p/:token");
    // other paths unchanged, including ones like /pnot-a-prefix that are not on a segment boundary
    expect(redactPublicTokens("/api/notes/abc")).toBe("/api/notes/abc");
    expect(redactPublicTokens("/pnot-a-prefix")).toBe("/pnot-a-prefix");
    expect(redactPublicTokens("/")).toBe("/");
    // Leaking variants: repeated leading slashes and case variants; the SPA fallback still serves them with
    // 200, so the masking must cover them.
    expect(redactPublicTokens(`//p/${t}`)).toBe("/p/:token");
    expect(redactPublicTokens(`/P/${t}`)).toBe("/p/:token");
    expect(redactPublicTokens(`//api/public/notes/${t}`)).toBe("/api/public/notes/:token");
  });

  it("redactPublicTokens two-segment form (#122 alias): the first segment is covered by the wide mask; the result shape is pinned", () => {
    // In the alias form the first segment is a handle, not a token: over-masking is harmless, but the result shape is pinned so that
    // narrowing the mask to "43-char segments only" turns this red: the alias form's first segment would then enter the log in clear
    // (a handle is not secret, but narrowing the mask is a behaviour change that needs an explicit decision).
    expect(redactPublicTokens("/p/alice/my-doc")).toBe("/p/:token/my-doc");
    expect(redactPublicTokens("/api/public/notes/alice/my-doc")).toBe("/api/public/notes/:token/my-doc");
    expect(redactPublicTokens("/api/public/notes/alice/my-doc/uploads/u1")).toBe("/api/public/notes/:token/my-doc/uploads/u1");
    expect(redactPublicTokens("//p/alice/my-doc")).toBe("/p/:token/my-doc");
  });

  it("isPublicSharePath two-segment form: /p/<handle>/<slug> is also within the noindex scope (pinned, not inferred)", () => {
    expect(isPublicSharePath("/p/alice/my-doc")).toBe(true);
    expect(isPublicSharePath("//P/alice/my-doc")).toBe(true);
    expect(isPublicSharePath("/n/alice/my-doc")).toBe(false);
  });
});
