import { describe, expect, it } from "vitest";
import { publicNoteApiPath, publicNoteQueryKey, publicRefIdentity } from "./public-note-ref";

const TOKEN = "abcDEF123_-".repeat(4).slice(0, 43);

describe("publicNoteApiPath (#122: builds the API URL for both forms)", () => {
  it("token form -> /api/public/notes/<token>", () => {
    expect(publicNoteApiPath({ kind: "token", token: TOKEN })).toBe(`/api/public/notes/${TOKEN}`);
  });

  it("alias form -> /api/public/notes/<handle>/<slug>; a non-ASCII slug is encoded first (fetch URL side)", () => {
    expect(publicNoteApiPath({ kind: "path", handle: "alice", slug: "my-doc" })).toBe(
      "/api/public/notes/alice/my-doc",
    );
    expect(publicNoteApiPath({ kind: "path", handle: "alice", slug: "café" })).toBe(
      "/api/public/notes/alice/caf%C3%A9",
    );
  });
});

describe("publicNoteQueryKey (the two forms must not share a key, or they would get each other's stale cache)", () => {
  it("token form and alias form have different prefixes, segments expanded per value", () => {
    expect(publicNoteQueryKey({ kind: "token", token: TOKEN })).toEqual(["public-note", TOKEN]);
    expect(publicNoteQueryKey({ kind: "path", handle: "alice", slug: "my-doc" })).toEqual([
      "public-note-by-path",
      "alice",
      "my-doc",
    ]);
  });
});

describe("publicRefIdentity (#269: shared by PublicNoteEditor's rebuild deps and the paragraph-anchor noteKey)", () => {
  it("token form -> token:<token>; alias form -> path:<handle>/<slug> (the two forms have different prefixes)", () => {
    expect(publicRefIdentity({ kind: "token", token: TOKEN })).toBe(`token:${TOKEN}`);
    expect(publicRefIdentity({ kind: "path", handle: "alice", slug: "my-doc" })).toBe("path:alice/my-doc");
  });
});
