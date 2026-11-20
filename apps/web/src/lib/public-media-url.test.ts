import { describe, expect, it } from "vitest";
import { BLOCKED_MEDIA_URL } from "./media-url";
import { publicMediaUrl } from "./public-media-url";

/** 43-character base64url, the same shape as the server-side token (the actual value does not affect the mapping logic). */
const TOKEN = "abcDEF123_-".repeat(4).slice(0, 43);

describe("publicMediaUrl token form (#72: resolveFileUrl mapping on public pages)", () => {
  const resolve = publicMediaUrl({ kind: "token", token: TOKEN });

  it("own relative upload URL /api/uploads/:id -> mapped to the public image endpoint (the token goes into the path)", () => {
    expect(resolve("/api/uploads/11111111-1111-1111-1111-111111111111")).toBe(
      `/api/public/notes/${TOKEN}/uploads/11111111-1111-1111-1111-111111111111`,
    );
  });

  it("external https absolute URLs pass through unchanged (hotlinking is allowed, see docs/known-limitations.md)", () => {
    expect(resolve("https://example.com/pic.png")).toBe("https://example.com/pic.png");
  });

  it("same-origin absolute URLs are not mapped (known limitation: an anonymous client has no session and the image breaks; guessing the origin is deliberately avoided)", () => {
    const absolute = `${window.location.origin}/api/uploads/22222222-2222-2222-2222-222222222222`;
    expect(resolve(absolute)).toBe(absolute);
  });

  it("dangerous schemes go through safeMediaUrl first -> about:blank (the mapping must not become a way around the #12 guard)", () => {
    expect(resolve("javascript:alert(1)")).toBe(BLOCKED_MEDIA_URL);
    expect(resolve("data:image/png;base64,AAA")).toBe(BLOCKED_MEDIA_URL);
  });

  it("empty string (BlockNote's \"no file yet\" representation) passes through unchanged, not mapped", () => {
    expect(resolve("")).toBe("");
  });

  it("an extra path segment (/api/uploads/a/b) is not the shape of an upload URL and is not mapped", () => {
    expect(resolve("/api/uploads/a/b")).toBe("/api/uploads/a/b");
  });

  it("variants with query/fragment are not mapped (own upload URLs do not carry them, and loose matching would only widen the attack surface)", () => {
    expect(resolve("/api/uploads/x?y=1")).toBe("/api/uploads/x?y=1");
    expect(resolve("/api/uploads/x#y")).toBe("/api/uploads/x#y");
  });
});

describe("publicMediaUrl alias form (#122: by-path variant of /p/<handle>/<slug>)", () => {
  const resolve = publicMediaUrl({ kind: "path", handle: "alice", slug: "my-doc" });

  it("own upload URL -> by-path image endpoint (the prefix is assembled by publicNoteApiPath according to the form)", () => {
    expect(resolve("/api/uploads/11111111-1111-1111-1111-111111111111")).toBe(
      "/api/public/notes/alice/my-doc/uploads/11111111-1111-1111-1111-111111111111",
    );
  });

  it("guard and allow rules are shared with the token form (same implementation: dangerous schemes blocked, external URLs allowed)", () => {
    expect(resolve("javascript:alert(1)")).toBe(BLOCKED_MEDIA_URL);
    expect(resolve("https://example.com/pic.png")).toBe("https://example.com/pic.png");
  });
});
