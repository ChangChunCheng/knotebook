/**
 * Only imported by `ShortcutsLazy.tsx` and tests, to keep the list data out of the entry bundle (bundle size limit).
 * Every id needs an e2e test run in a real browser, its name ending in `[sc:<id>]` (checked both ways by
 * `shortcut-e2e-coverage.test.ts`); descriptions (`items.<id>.desc` in `i18n/shortcuts.*.json`) state only behavior
 * that e2e verifies. See e2e/tests/43-shortcuts.spec.ts.
 */
export const SHORTCUT_CATEGORIES = ["global", "typing", "markdown", "formatting", "columns", "sidebar", "presentation", "ai", "mouse"] as const;
export type ShortcutCategory = (typeof SHORTCUT_CATEGORIES)[number];

/** `Mod` is Ctrl, shown as ⌘ on Mac; other single keys are written as the letter. `Click` is a mouse click (its text comes from the string bundle). */
export type KeyToken =
  | "Mod"
  | "Shift"
  | "Alt"
  | "Enter"
  | "Space"
  | "Esc"
  | "Tab"
  | "Backspace"
  | "Delete"
  | "Click"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | (string & {});

/** combo: one <kbd> per token; typed: one <kbd> for the typed text; action: mouse gesture with no <kbd>. */
export type ShortcutKeys = { kind: "combo"; keys: readonly KeyToken[] } | { kind: "typed"; text: string; thenSpace?: boolean } | { kind: "action" };

export type SiteCapability = "ai" | "aiInstruct";

export interface ShortcutEntry {
  /** i18n keys: `shortcutsGuide.items.<id>.name` / `.desc`; e2e tag `[sc:<id>]`. */
  id: string;
  category: ShortcutCategory;
  keys: readonly ShortcutKeys[];
  /** Mac-only alternative (redo lists only ⌘⇧Z). */
  macKeys?: readonly ShortcutKeys[];
  /** Required with two or more keys: or = alternatives for one action; pair = distinct actions. */
  sep?: "or" | "pair";
  requires?: SiteCapability;
}

const combo = (...keys: KeyToken[]): ShortcutKeys => ({ kind: "combo", keys });
const typed = (text: string, thenSpace = false): ShortcutKeys => ({ kind: "typed", text, thenSpace });
const action: ShortcutKeys = { kind: "action" };

export const SHORTCUTS: readonly ShortcutEntry[] = [
  { id: "search", category: "global", keys: [combo("Mod", "K")] },
  { id: "searchClear", category: "global", keys: [combo("Esc")] },
  { id: "saveVersion", category: "global", keys: [combo("Mod", "S")] },
  { id: "openSettings", category: "global", keys: [combo("Mod", ",")] },
  { id: "openShortcuts", category: "global", keys: [combo("Mod", "/")] },
  { id: "slashMenu", category: "typing", keys: [typed("/")] },
  { id: "wikilink", category: "typing", keys: [typed("[[")] },
  { id: "markdownLink", category: "typing", keys: [typed("[…](…)")] },
  { id: "heading", category: "markdown", keys: [typed("#", true), typed("##", true), typed("###", true)], sep: "pair" },
  { id: "bullet", category: "markdown", keys: [typed("-", true), typed("*", true), typed("+", true)], sep: "or" },
  { id: "numbered", category: "markdown", keys: [typed("1.", true)] },
  { id: "checklist", category: "markdown", keys: [typed("[]", true), typed("[x]", true)], sep: "pair" },
  { id: "quote", category: "markdown", keys: [typed(">", true)] },
  { id: "codeBlock", category: "markdown", keys: [typed("```", true)] },
  { id: "divider", category: "markdown", keys: [typed("---")] },
  { id: "inlineCode", category: "markdown", keys: [typed("`…`")] },
  { id: "inlineMarks", category: "markdown", keys: [typed("**…**"), typed("*…*"), typed("~~…~~")], sep: "pair" },
  { id: "bold", category: "formatting", keys: [combo("Mod", "B")] },
  { id: "italic", category: "formatting", keys: [combo("Mod", "I")] },
  { id: "underline", category: "formatting", keys: [combo("Mod", "U")] },
  { id: "strike", category: "formatting", keys: [combo("Mod", "Shift", "S")] },
  { id: "codeMark", category: "formatting", keys: [combo("Mod", "E")] },
  { id: "link", category: "formatting", keys: [combo("Mod", "K")] },
  { id: "undo", category: "formatting", keys: [combo("Mod", "Z")] },
  { id: "redo", category: "formatting", keys: [combo("Mod", "Y"), combo("Mod", "Shift", "Z")], macKeys: [combo("Mod", "Shift", "Z")], sep: "or" },
  { id: "indent", category: "formatting", keys: [combo("Tab"), combo("Shift", "Tab")], sep: "pair" },
  { id: "lineBreak", category: "formatting", keys: [combo("Shift", "Enter")] },
  { id: "moveBlock", category: "formatting", keys: [combo("Mod", "Shift", "ArrowUp"), combo("Mod", "Shift", "ArrowDown")], sep: "pair" },
  { id: "columnsInsert", category: "columns", keys: [typed("/grid")] },
  { id: "columnBackspace", category: "columns", keys: [combo("Backspace")] },
  { id: "columnDelete", category: "columns", keys: [combo("Delete")] },
  { id: "columnUngroup", category: "columns", keys: [action] },
  { id: "columnsDragBeside", category: "columns", keys: [action] },
  { id: "columnResizeKeys", category: "columns", keys: [combo("ArrowLeft"), combo("ArrowRight")], sep: "pair" },
  { id: "selectEsc", category: "sidebar", keys: [combo("Esc")] },
  { id: "selectRange", category: "sidebar", keys: [combo("Shift", "Click")] },
  {
    id: "presentNav",
    category: "presentation",
    keys: [combo("ArrowRight"), combo("ArrowLeft"), combo("ArrowDown"), combo("ArrowUp")],
    sep: "pair",
  },
  { id: "presentOverview", category: "presentation", keys: [combo("O")] },
  { id: "presentFullscreen", category: "presentation", keys: [combo("F")] },
  { id: "presentExit", category: "presentation", keys: [combo("Esc")] },
  { id: "aiSelect", category: "ai", keys: [action], requires: "ai" },
  { id: "aiSend", category: "ai", keys: [combo("Enter"), combo("Shift", "Enter")], sep: "pair", requires: "aiInstruct" },
  { id: "aiClose", category: "ai", keys: [combo("Esc")], requires: "ai" },
  { id: "dragBlock", category: "mouse", keys: [action] },
  // Copy-drag: ProseMirror reads the modifier at drop time (⌥ on Mac, Ctrl elsewhere).
  { id: "dragBlockCopy", category: "mouse", keys: [combo("Ctrl")], macKeys: [combo("Alt")] },
  { id: "dragNoteToEditor", category: "mouse", keys: [action] },
  { id: "dragNoteToFolder", category: "mouse", keys: [action] },
];

export function visibleShortcuts(site: { aiAvailable: boolean; aiInstruct: boolean }): { category: ShortcutCategory; entries: ShortcutEntry[] }[] {
  const allowed = (e: ShortcutEntry): boolean => {
    if (e.requires === "ai") return site.aiAvailable;
    if (e.requires === "aiInstruct") return site.aiAvailable && site.aiInstruct;
    return true;
  };
  return SHORTCUT_CATEGORIES.map((category) => ({ category, entries: SHORTCUTS.filter((e) => e.category === category && allowed(e)) })).filter(
    (group) => group.entries.length > 0,
  );
}
