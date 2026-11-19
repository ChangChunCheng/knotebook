/**
 * Blocks every user change to the demo notes while on. Filtered at transaction level because IME
 * composition (keyCode 229) writes into the document even when `preventDefault`ed; only
 * `filterTransaction` sees that tr (`composition` meta).
 * Mounted once with a flag instead of `registerPlugin` on demo start: registering/removing a
 * plugin rebuilds every plugin view, which resets BlockNote's menu plugin state to closed while a
 * menu is shown, and a later `closeMenu()` throws. Toggling dispatches nothing (on unregister
 * the editor may already be unmounted).
 * Appended transactions are filtered against the state after their root, not `view.state`, so
 * any tr whose state isn't `view.state` is allowed; roots cover all user input, so nothing slips
 * through. Blocking them would leave tour-inserted blocks without ids and break normalization
 * after remote sync.
 */
import { Extension } from "@tiptap/core";
import { createPmPlugin } from "./pm-plugin";
import { Y_SYNC_META } from "./site-link-pm";
import { isTourTransactionFilterOn, TOUR_TRANSACTION_META } from "./tour-filter-flag";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror Transaction can't be value-imported in apps/web
type Any = any;

// Root trs allowed: no doc change, the tour's own, and `y-sync$` ones (remote edits, undo/redo via Y); blocking those would desync PM and the Y.Doc.
function allowedWhileFiltering(tr: Any): boolean {
  return !tr.docChanged || tr.getMeta(TOUR_TRANSACTION_META) !== undefined || tr.getMeta(Y_SYNC_META) !== undefined;
}

export function createTourTransactionFilterExtension(): Extension {
  return Extension.create({
    name: "knotebookTourTransactionFilter",
    addProseMirrorPlugins() {
      const { editor } = this;
      return [
        createPmPlugin({
          filterTransaction: (tr, state) => !isTourTransactionFilterOn(editor) || state !== editor.view.state || allowedWhileFiltering(tr),
        }) as never,
      ];
    },
  });
}
