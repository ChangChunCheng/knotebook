import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMenuContext } from "@mantine/core";
import { useBlockNoteEditor } from "@blocknote/react";
import { pushRecentColor } from "@/lib/recent-colors";
import { applyColor } from "./apply-color";
import { CustomColorPanel } from "./CustomColorPanel";
import type { PanelRequest } from "./types";

interface ColorMenuApi {
  openPanel(req: PanelRequest): void;
  back(): void;
}

const ColorMenuContext = createContext<ColorMenuApi | null>(null);

export function useColorMenu(): ColorMenuApi | null {
  return useContext(ColorMenuContext);
}

/**
 * The panel opens in the root dropdown, not a submenu: submenus open on hover and would close as soon as the pointer leaves while dragging the square or typing in the hex field.
 * `pinFocus` is passed only by the format toolbar: its focus trap re-grabs focus on every repaint, so the panel pins focus in place (see `CustomColorPanel`).
 */
export function ColorMenuBody({ children, pinFocus = false }: { children: ReactNode; pinFocus?: boolean }) {
  const editor = useBlockNoteEditor();
  const menu = useMenuContext();
  const [view, setView] = useState<"items" | PanelRequest>("items");
  const panelRef = useRef<HTMLDivElement>(null);
  // Focus target after going back: remember the dropdown node and the `data-kb-color-return` value, find it once the item list is back.
  const pendingReturn = useRef<{ dropdown: Element | null; key: string } | null>(null);

  const api = useMemo<ColorMenuApi>(
    () => ({
      openPanel: (req) => setView(req),
      back: () => {
        if (view === "items") return;
        pendingReturn.current = {
          dropdown: panelRef.current?.closest("[data-menu-dropdown]") ?? null,
          key: view.returnTo,
        };
        setView("items");
      },
    }),
    [view],
  );

  useLayoutEffect(() => {
    const pending = pendingReturn.current;
    if (view !== "items" || !pending) return;
    pendingReturn.current = null;
    pending.dropdown?.querySelector<HTMLElement>(`[data-kb-color-return="${pending.key}"]`)?.focus();
  }, [view]);

  const onApply = (req: PanelRequest, hex: string) => {
    if (applyColor(editor, req.section, req.target, hex)) pushRecentColor(hex);
    // Plain <button> in the panel: unlike Menu.Item it doesn't close the menu itself.
    menu.closeDropdownImmediately();
    // Return focus to the editor only after the menu closed and the focus trap let go.
    setTimeout(() => editor.focus());
  };

  return (
    <ColorMenuContext.Provider value={api}>
      {view === "items" ? (
        children
      ) : (
        <CustomColorPanel
          ref={panelRef}
          request={view}
          pinFocus={pinFocus}
          onBack={api.back}
          onApply={(hex) => onApply(view, hex)}
        />
      )}
    </ColorMenuContext.Provider>
  );
}
