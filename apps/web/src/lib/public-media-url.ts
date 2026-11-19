import { safeMediaUrl } from "./media-url";
import { publicNoteApiPath, type PublicNoteRef } from "./public-note-ref";

/**
 * Anonymous visitors have no session, so `/api/uploads/:id` would be 401; map it to the
 * login-free public endpoint, which authorizes this note's own blobs. Done via resolveFileUrl,
 * not by rewriting blocks: in collab mode the content is the Y.Doc, so that would write to a
 * read-only page.
 *
 * {@link safeMediaUrl} runs first so the mapping cannot bypass the render-side guard. Only the
 * exact `/api/uploads/<one segment>` shape is mapped, since a loose match would route unknown
 * shapes into the public endpoint; same-origin absolute URLs therefore show a broken image for
 * anonymous visitors (docs/known-limitations.md, #72).
 */
export function publicMediaUrl(ref: PublicNoteRef): (url: string) => string {
  const base = publicNoteApiPath(ref);
  return (raw: string): string => {
    const safe = safeMediaUrl(raw);
    if (safe !== raw) return safe;
    const match = /^\/api\/uploads\/([^/?#]+)$/.exec(raw);
    if (!match) return raw;
    return `${base}/uploads/${match[1]}`;
  };
}
