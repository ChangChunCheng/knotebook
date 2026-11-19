import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { clearSearchMark } from "@/hooks/search-mark";
import { OVERLAY_QUERY, isPhone } from "@/lib/layout-tiers";
import { PhoneListContext } from "@/lib/phone-list";
import { SidebarDrawerContext } from "@/lib/sidebar-drawer";
import { EMPTY_SELECTION, reduceSelection, type SelectionOp, type SidebarSelection } from "@/lib/sidebar-selection";

/**
 * Lives in `lib/` to avoid import cycles (as `sidebar-drawer.ts`).
 * - Two contexts: the note page is AppShell's `children`, so consuming state there would repaint it on every tab switch;
 *   `SidebarTabActionsContext` holds only stable functions, `SidebarTabStateContext` is for sidebar components.
 * - Selection lives here so the static card and the drawer share it; switching tab, drawer Esc and starting a search end it.
 * - `showTab` reads refs instead of the drawer/phone-list contexts: the `SidebarDrawerContext.Provider` value in
 *   `AppShell` is a new object every render and would make the actions object change with it.
 */
export type SidebarTab = "recent" | "favorites" | "myNotes" | "workspace" | "shared" | "trash";

export const SIDEBAR_TABS: readonly SidebarTab[] = ["recent", "favorites", "myNotes", "workspace", "shared", "trash"];
export const DEFAULT_SIDEBAR_TAB: SidebarTab = "myNotes";
export const SIDEBAR_TAB_STORAGE_KEY = "sidebar.tab";

export function readSidebarTab(): SidebarTab {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_TAB_STORAGE_KEY);
    return SIDEBAR_TABS.find((tab) => tab === raw) ?? DEFAULT_SIDEBAR_TAB;
  } catch {
    return DEFAULT_SIDEBAR_TAB;
  }
}

export function writeSidebarTab(tab: SidebarTab): void {
  try {
    window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, tab);
  } catch {
  }
}

export interface SidebarTabActions {
  /** `reveal: false` switches the tab without moving the screen (e.g. restoring the pre-tour tab). */
  showTab: (tab: SidebarTab, options?: { reveal?: boolean }) => void;
  updateSelection: (op: SelectionOp) => void;
  endSelectionIfActive: () => boolean;
  /**
   * Selection round counter. A batch records it at start and applies its result only if unchanged, even when the component
   * is gone (closing the drawer unmounts the action bar, but the selection remains).
   */
  getSelectionSession: () => number | null;
  /** Stable getter for callers outside the provider (`AppShell` hands it to the feature tour). */
  getTab: () => SidebarTab;
}
export interface SidebarTabState {
  tab: SidebarTab;
  selection: SidebarSelection;
}

export const SidebarTabActionsContext = createContext<SidebarTabActions | null>(null);
export const SidebarTabStateContext = createContext<SidebarTabState | null>(null);

const NOOP_ACTIONS: SidebarTabActions = {
  showTab: () => {},
  updateSelection: () => {},
  endSelectionIfActive: () => false,
  getSelectionSession: () => null,
  getTab: () => DEFAULT_SIDEBAR_TAB,
};
const DEFAULT_STATE: SidebarTabState = { tab: DEFAULT_SIDEBAR_TAB, selection: EMPTY_SELECTION };

export function SidebarTabProvider({
  children,
  actionsRef,
}: {
  children: ReactNode;
  actionsRef?: MutableRefObject<SidebarTabActions | null>;
}) {
  const [tab, setTab] = useState<SidebarTab>(readSidebarTab);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [selection, dispatchSelection] = useReducer(reduceSelection, EMPTY_SELECTION);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const sessionRef = useRef(0);
  const drawer = useContext(SidebarDrawerContext);
  const drawerRef = useRef(drawer);
  drawerRef.current = drawer;
  const phoneList = useContext(PhoneListContext);
  const phoneListRef = useRef(phoneList);
  phoneListRef.current = phoneList;

  const showTab = useCallback((next: SidebarTab, options?: { reveal?: boolean }) => {
    setTab(next);
    writeSidebarTab(next);
    if (next !== tabRef.current) {
      dispatchSelection({ type: "end" });
      clearSearchMark(); // switching tab with an empty search box = leaving search: clear the mark a search jump left in the note
    }
    if (options?.reveal === false) return;
    if (isPhone()) phoneListRef.current?.backToList();
    else if (window.matchMedia(OVERLAY_QUERY).matches) drawerRef.current?.setOpen(true);
  }, []);

  const endSelectionIfActive = useCallback(() => {
    if (!selectionRef.current.active) return false;
    dispatchSelection({ type: "end" });
    return true;
  }, []);

  const updateSelection = useCallback((op: SelectionOp) => {
    if (op.type === "start") sessionRef.current += 1;
    dispatchSelection(op);
  }, []);

  const getSelectionSession = useCallback(() => (selectionRef.current.active ? sessionRef.current : null), []);

  const getTab = useCallback(() => tabRef.current, []);

  const actions = useMemo<SidebarTabActions>(
    () => ({ showTab, updateSelection, endSelectionIfActive, getSelectionSession, getTab }),
    [showTab, updateSelection, endSelectionIfActive, getSelectionSession, getTab],
  );
  if (actionsRef) actionsRef.current = actions;
  const state = useMemo<SidebarTabState>(() => ({ tab, selection }), [tab, selection]);

  return (
    <SidebarTabActionsContext.Provider value={actions}>
      <SidebarTabStateContext.Provider value={state}>{children}</SidebarTabStateContext.Provider>
    </SidebarTabActionsContext.Provider>
  );
}

export function useSidebarTabActions(): SidebarTabActions {
  return useContext(SidebarTabActionsContext) ?? NOOP_ACTIONS;
}

export function useSidebarTabState(): SidebarTabState {
  return useContext(SidebarTabStateContext) ?? DEFAULT_STATE;
}
