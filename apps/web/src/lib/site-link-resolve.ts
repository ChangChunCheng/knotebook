import { targetFromList, type NoteDto, type SiteLinkCandidate, type SiteLinkTarget, type SiteNoteHref } from "@knotebook/shared";
import { api } from "@/api/client";

/** #269: the sync layer is the `["notes"]` cache; the session endpoints also cover the redirect table / prev_slug / legacy slugs. */
export type CacheResolution = { kind: "hit"; target: SiteLinkTarget } | { kind: "miss" } | { kind: "unknown" };

export function resolveFromCache(notes: readonly SiteLinkCandidate[] | undefined, parsed: SiteNoteHref): CacheResolution {
  if (!notes) return { kind: "unknown" };
  const target = targetFromList(parsed.path, notes);
  return target ? { kind: "hit", target } : { kind: "miss" };
}

/** Per conversion action: at most 20 distinct hrefs, 5 s timeout per request. */
export const FALLBACK_MAX_HREFS = 20;
export const FALLBACK_TIMEOUT_MS = 5_000;

function endpointOf(parsed: SiteNoteHref): string {
  const p = parsed.path;
  if (p.kind === "n") return `/api/notes/by-path/${encodeURIComponent(p.handle)}/${encodeURIComponent(p.slug)}`;
  if (p.kind === "g") return `/api/notes/by-group-path/${encodeURIComponent(p.groupId)}/${encodeURIComponent(p.slug)}`;
  return `/api/notes/${encodeURIComponent(p.ref)}`;
}

export async function resolveViaServer(parsed: SiteNoteHref, timeoutMs = FALLBACK_TIMEOUT_MS): Promise<SiteLinkTarget | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const dto = await api<NoteDto>(endpointOf(parsed), { signal: controller.signal });
    return { id: dto.id, title: dto.title };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
