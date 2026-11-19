import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { canEdit, stopsReconnect, type CollabState } from "@/collab/connection";
import { cn } from "@/lib/utils";

/** Delay before escalating to the offline warning (ms, #48): the first moments of opening a note and short reconnects pass through connecting phases and must not flash a warning; 3 s filters these without delaying the "editing offline" warning too long. */
export const OFFLINE_WARN_MS = 3_000;

/** `connected` uses a literal colour: the status green is theme-independent. */
const PHASE_STYLES: Record<CollabState["phase"], { key: string; dotClassName: string; dotStyle?: CSSProperties }> = {
  connecting: { key: "note.connection.connecting", dotClassName: "bg-muted-foreground" },
  connected: { key: "note.connection.connected", dotClassName: "", dotStyle: { backgroundColor: "oklch(0.8 0.17 152)" } },
  "reconnecting-once": { key: "note.connection.reconnecting", dotClassName: "bg-muted-foreground" },
  kicked: { key: "note.connection.kicked", dotClassName: "bg-destructive" },
  deleted: { key: "note.connection.deleted", dotClassName: "bg-destructive" },
  outdated: { key: "note.connection.outdated", dotClassName: "bg-muted-foreground" },
};

/**
 * Escalation (#48): after `OFFLINE_WARN_MS` outside connected, the dot turns warning and the text depends on `synced`. Never synced: "Not loaded — offline" and read-only (NotePage also blocks editing). Synced then disconnected: still editable, "Editing offline".
 * `role="status"` + polite: revocation/downgrade/offline are not user-initiated, so screen readers should learn of them without interruption.
 * The status dot has no text node so e2e `hasText:/^Connected/` and `/^Read-only/` prefix matches keep working.
 */
export function ConnectionBadge({
  state,
  synced,
  canEdit: roleCanEdit,
}: {
  state: CollabState;
  synced: boolean;
  /** Offline phases have no `role`, so the caller computes this: a viewer shows neutral "offline" ("not synced" would be false for someone with no changes). */
  canEdit: boolean;
}) {
  const { t } = useTranslation();

  // A timer (not phase-entry subtraction) re-renders exactly when the threshold passes.
  // "Not usable yet" includes connected-but-not-synced: `provider.synced` needs another round trip, and a slow or failing server `onLoadDocument` would otherwise stay on "Connected" over a blank read-only note forever. Same timer, so normal opens (<1s) never flash.
  const [offlineSustained, setOfflineSustained] = useState(false);
  const offlinePhase = !stopsReconnect(state) && (state.phase !== "connected" || !synced);
  // Read through a ref so the effect depends only on offlinePhase; otherwise setOfflineSustained re-renders would keep resetting the timer.
  const sustainedRef = useRef(offlineSustained);
  sustainedRef.current = offlineSustained;

  useEffect(() => {
    if (!offlinePhase) {
      if (sustainedRef.current) setOfflineSustained(false);
      return;
    }
    if (sustainedRef.current) return;
    const timer = setTimeout(() => setOfflineSustained(true), OFFLINE_WARN_MS);
    return () => clearTimeout(timer);
  }, [offlinePhase]);

  const showOffline = offlinePhase && offlineSustained;
  const offlineKey = !synced
    ? "note.connection.offlineUnsynced"
    : roleCanEdit
      ? "note.connection.offlineEditing"
      : "note.connection.offline";
  const phase = showOffline ? { key: offlineKey, dotClassName: "bg-destructive" } : PHASE_STYLES[state.phase];

  // Viewers show "Read-only" as soon as connected (an unsynced editor is read-only anyway); showOffline takes priority.
  const readOnlyLabel = !showOffline && state.phase === "connected" && !canEdit(state.role) ? "note.readOnly" : null;

  return (
    <div role="status" aria-live="polite" className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", phase.dotClassName)} style={phase.dotStyle} />
      {/* Not `hidden`: the container is aria-live and display:none would stop screen readers getting status changes. */}
      <span className="max-sm:sr-only @max-[36rem]:sr-only">{t(readOnlyLabel ?? phase.key)}</span>
    </div>
  );
}
