import { lazy, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AiPreview } from "@/ai/preview";
import { Button } from "@/components/ui/button";
import { VersionsLazyBoundary } from "@/components/versions/VersionsLazyBoundary";
import { useAiSession, type AiSessionState } from "./AiSession";

// Load only this way: a static import moves DiffEditor and the diff package into the NotePage chunk.
const SelectionAiPreview = lazy(() =>
  import("@/components/versions/VersionsLazy").then((m) => ({ default: m.SelectionAiPreview })),
);

export type BoxFocusTarget = "cancel" | "container" | "editor";
/** Runs the action; if focus was inside the box before and the action took effect (didn't return false), focuses `target` after the transition. */
export type RunWithFocus = (action: () => boolean | void, target: BoxFocusTarget) => void;

type DoneState = Extract<AiSessionState, { phase: "done" }>;

/** Stable key per preview object: a new preview remounts the child (old cleanup runs onReady(null) before the new onReady). */
function usePreviewKey(preview: AiPreview): number {
  const keys = useRef(new WeakMap<AiPreview, number>());
  const next = useRef(0);
  let key = keys.current.get(preview);
  if (key === undefined) {
    next.current += 1;
    key = next.current;
    keys.current.set(preview, key);
  }
  return key;
}

/**
 * `previewReady` is derived from the child's `onReady`, not reset in an effect: child effects run before the parent's,
 * so with a cached module the parent would clear the flag for good. Apply stays disabled until ready (you can't apply
 * what you haven't seen), and also on a boundary error, leaving discard. `onReady` is
 * `setReadyFor` itself (stable); an inline arrow would rerun child cleanup/ready on every parent render.
 */
export function SelectionAiResult({ state, anchorOk, run }: { state: DoneState; anchorOk: boolean; run: RunWithFocus }) {
  const { t } = useTranslation();
  const session = useAiSession();
  const [readyFor, setReadyFor] = useState<AiPreview | null>(null);
  const previewReady = readyFor === state.preview;
  const previewKey = usePreviewKey(state.preview);

  return (
    <div className="flex flex-col">
      {state.preview.noChange && <p role="status" className="px-3 pt-2 text-xs text-muted-foreground">{t("ai.box.noChange")}</p>}
      <div className="kb-ai-preview">
        <VersionsLazyBoundary
          noteId={state.target.anchor.noteId}
          fallback={<p className="px-3 py-2 text-xs text-muted-foreground">{t("ai.box.loadingPreview")}</p>}
          crashMessageKey="ai.box.previewCrash"
          errorClassName="px-3 py-2"
        >
          <SelectionAiPreview key={previewKey} preview={state.preview} onReady={setReadyFor} />
        </VersionsLazyBoundary>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border px-3 py-2">
        {state.applied !== null ? (
          <>
            <Button type="button" variant="outline" size="sm" disabled={!anchorOk} onClick={() => run(() => session.revert(), "container")}>
              {t("ai.box.revert")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => run(() => session.close(), "editor")}>
              {t("ai.box.close")}
            </Button>
          </>
        ) : (
          <>
            {anchorOk && (
              <Button
                type="button"
                variant="brandDeep"
                size="sm"
                disabled={state.preview.noChange || !previewReady}
                onClick={() => run(() => session.apply(previewReady), "editor")}
              >
                {t("ai.box.apply")}
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => run(() => session.close(), "editor")}>
              {t("ai.box.discard")}
            </Button>
            {anchorOk && (
              <Button type="button" variant="outline" size="sm" onClick={() => run(() => session.retry(), "cancel")}>
                {t("ai.box.retry")}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
