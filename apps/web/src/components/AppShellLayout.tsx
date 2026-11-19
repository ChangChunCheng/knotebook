import { useMemo, useState } from "react";
import { Outlet } from "react-router";
import { AppShell } from "@/components/AppShell";
import { BlockAnchorContext, NO_BLOCK_ANCHOR, type BlockAnchorApi } from "@/hooks/block-anchor-context";
import { AppShellInertContext } from "@/lib/app-shell-inert";
import { NotePageControlsContext, type NotePageControls } from "@/lib/note-page-controls";
import { NotePageBridgeContext, type NotePageBridge } from "@/lib/note-page-bridge";

/** Sidebar shell mounts once so list scroll and selection mode survive route changes. */
export function AppShellLayout() {
  const [inert, setInert] = useState(false);
  const [controls, setControls] = useState<NotePageControls | null>(null);
  const [anchors, setAnchors] = useState<BlockAnchorApi | null>(null);
  const bridge = useMemo<NotePageBridge>(() => ({ setControls, setAnchors }), []);
  return (
    <AppShellInertContext.Provider value={setInert}>
      <NotePageBridgeContext.Provider value={bridge}>
        <NotePageControlsContext.Provider value={controls}>
          <BlockAnchorContext.Provider value={anchors ?? NO_BLOCK_ANCHOR}>
            <AppShell inert={inert}>
              <Outlet />
            </AppShell>
          </BlockAnchorContext.Provider>
        </NotePageControlsContext.Provider>
      </NotePageBridgeContext.Provider>
    </AppShellInertContext.Provider>
  );
}
