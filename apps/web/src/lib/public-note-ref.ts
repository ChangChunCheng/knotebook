/**
 * `/p/:token` and `/p/:handle/:slug` share one page/editor/image mapping through this union, not a bare token (#122).
 * The `/p/` page URL is assembled by `publicAliasPath` in shared (validated input, not encoded); the API path here encodes
 * defensively, so the two deliberately do not share code.
 * API paths are built only by `publicNoteApiPath` (the page query and publicMediaUrl both use it); building them
 * elsewhere lets the two drift into broken images.
 */
export type PublicNoteRef =
  | { kind: "token"; token: string }
  | { kind: "path"; handle: string; slug: string };

/**
 * Both segments are encoded because they are raw URL params. No normalization here: the server's `normalizeHandle` /
 * `normalizeSlug` converge NFD/case, so every spelling hits (each with its own query key).
 */
export function publicNoteApiPath(ref: PublicNoteRef): string {
  if (ref.kind === "token") {
    return `/api/public/notes/${encodeURIComponent(ref.token)}`;
  }
  return `/api/public/notes/${encodeURIComponent(ref.handle)}/${encodeURIComponent(ref.slug)}`;
}

/**
 * The two shapes must not share a key, or going from a token page to an alias page would pick up the other's cache.
 * Segments are spread by value: the ref object's identity is unstable.
 */
export function publicNoteQueryKey(ref: PublicNoteRef): readonly string[] {
  if (ref.kind === "token") {
    return ["public-note", ref.token];
  }
  return ["public-note-by-path", ref.handle, ref.slug];
}

/** Per-value identity (the ref object's identity is unstable); the shapes have different prefixes. */
export function publicRefIdentity(ref: PublicNoteRef): string {
  return ref.kind === "token" ? `token:${ref.token}` : `path:${ref.handle}/${ref.slug}`;
}
