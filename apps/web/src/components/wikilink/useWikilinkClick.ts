import { useCallback, useContext, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { toast } from "@/components/ui/toast";
import { TOP_SECTION_ID } from "@knotebook/shared";
import { BlockAnchorContext } from "@/hooks/block-anchor-context";
import { FIND_STATE_KEY } from "@/hooks/useBlockAnchor";

export interface WikilinkClickTarget {
  /**
   * Plain-click destination: member hit = canonical URL plus anchor; list not loaded yet = `/notes/<id>[#b-…]`;
   * public = `/p/…[#b-…]`; same note on a public page = `#b-…`.
   */
  href: string;
  /** null: same-note anchor on a public page (it doesn't know its own note id). */
  targetNoteId: string | null;
  anchorBlockId: string;
  broken: boolean;
  /**
   * Text to find within the section (`forQuery`). Same note passes it to `requestAnchor`; another note gets it via
   * navigation state (`FIND_STATE_KEY`), not the URL. Omitted: plain anchor behavior.
   */
  findText?: string;
}

/** Modified or non-left clicks are left to the browser (new tab/window). */
export function isPlainLeftClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function useWikilinkActivate() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const anchors = useContext(BlockAnchorContext);
  return useCallback(
    (target: WikilinkClickTarget) => {
      if (target.broken) {
        toast({ title: t("note.wikilinkBroken") });
        return;
      }
      const samePage =
        target.targetNoteId === null ||
        (anchors.currentNoteId !== null && target.targetNoteId.toLowerCase() === anchors.currentNoteId.toLowerCase());
      if (samePage) {
        if (target.anchorBlockId !== "") {
          if (target.findText === undefined) anchors.requestAnchor(target.anchorBlockId);
          else anchors.requestAnchor(target.anchorBlockId, target.findText);
          void navigate(
            { search: location.search, hash: `#b-${target.anchorBlockId}` },
            { replace: false, ...(target.findText === undefined ? {} : { state: { [FIND_STATE_KEY]: target.findText } }) },
          );
        } else if (target.findText !== undefined) {
          anchors.requestAnchor(TOP_SECTION_ID, target.findText);
          // Same-note `_top` has no hash to change: also store findText in the current history entry (replace) so
          // reload jumps back, and a previous search's findText isn't reused.
          void navigate({ search: location.search, hash: "" }, { replace: true, state: { [FIND_STATE_KEY]: target.findText } });
        } else {
          anchors.scrollToTop();
        }
        return;
      }
      void navigate(target.href, target.findText === undefined ? undefined : { state: { [FIND_STATE_KEY]: target.findText } });
    },
    [anchors, location.search, navigate, t],
  );
}

/**
 * The only wikilink click handler (member, public, and same-note `#b-` links on public pages); it navigates even
 * when editable, since the toolbar opens on hover or long-press.
 * Not `<Link>`: on the same path and hash it REPLACEs, so Back can't return to before the click.
 * Not the native `<a href>`: fragment navigation bypasses react-router and blocks have `data-id` but no `id`, so the browser can't scroll.
 * Same-note anchors call `requestAnchor` before `navigate({ search, hash }, { replace: false })`: scrolling is driven by the pending anchor, not by the router making a new key.
 */
export function useWikilinkClick() {
  const activate = useWikilinkActivate();
  return useCallback(
    (event: MouseEvent<HTMLElement>, target: WikilinkClickTarget) => {
      if (!isPlainLeftClick(event)) return;
      event.preventDefault();
      activate(target);
    },
    [activate],
  );
}
