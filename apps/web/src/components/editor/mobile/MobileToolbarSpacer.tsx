import { PHONE_EDIT_TOOLBAR_CLEARANCE_PX } from "@/components/ai/SelectionAiController";
import { useKeyboardInset } from "@/lib/visual-viewport";
import { useColorPanelHeight } from "./toolbar-footprint";

/**
 * Trailing space at the end of the article column: keyboard + toolbar frame height (the colour panel's height while it is open).
 * Without it the last lines sit in the bottom 24px behind the floating toolbar and ProseMirror has no scrollable room to push the caret up.
 * The bottom safe area isn't added here: the note body already pads it (`NoteEditor`'s `max-sm:pb-[env(safe-area-inset-bottom)]`), adding it again would count twice.
 */
export function MobileToolbarSpacer() {
  const inset = Math.max(useKeyboardInset(), useColorPanelHeight());
  return <div aria-hidden="true" data-mobile-toolbar-spacer="" className="shrink-0" style={{ height: `${inset + PHONE_EDIT_TOOLBAR_CLEARANCE_PX}px` }} />;
}
