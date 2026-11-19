/**
 * Found by the `data-kb-tour-target` attribute, never by accessible name or text: the sidebar is full of user-chosen
 * names, so a name lookup would eventually collide. Main bundle: only the attribute name, ids and `tourTarget`; the
 * lookup code is in `lib/tour-find.ts`.
 */

export type TourTargetId =
  | "tabs"
  | "newNote"
  | "newFolder"
  | "search"
  | "share"
  | "noteMenu"
  | "noteWidth"
  | "versions"
  | "userMenu"
  | "drawerButton"
  | "backToList"
  | "phoneNewNote"
  | "phoneSearch"
  | "wikilinkMenu"
  | "slashMenu"
  | "wikilink"
  | "flowchart";

export const TOUR_TARGET_ATTR = "data-kb-tour-target";

export function tourTarget(id: TourTargetId): { "data-kb-tour-target": TourTargetId } {
  return { "data-kb-tour-target": id };
}
