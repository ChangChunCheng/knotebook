import { useEffect, useMemo } from "react";
import type { AiPreview } from "@/ai/preview";
import { DiffEditor } from "@/components/versions/VersionPreview";
import { diffBlocks, renderDiff } from "@/lib/version-diff";
import { useWikilinkTitleOf } from "@/lib/use-wikilink-titles";

/**
 * Load only via `VersionsLazy` (mount point wrapped in `VersionsLazyBoundary`): a static import makes Rollup move
 * `DiffEditor`, `@/lib/version-diff` and the `diff` package into the caller's chunk, which trips the `u{2DE}-` (diff
 * package literal) marker in `scripts/check-bundle-size.mjs` (run it after a build).
 * `onReady(preview)` fires after mount with the object it rendered, `onReady(null)` in cleanup. A boundary error (this
 * unmounts) or a new preview (the parent remounts by key; React runs the old cleanup before the new effect) both keep
 * the parent's `readyFor` correct.
 */
export function SelectionAiPreview({ preview, onReady }: { preview: AiPreview; onReady: (ready: AiPreview | null) => void }) {
  // `DiffEditor` rebuilds the editor when the `blocks` identity changes: keep it memoized.
  const titleOf = useWikilinkTitleOf(preview.before, preview.after);
  const rendered = useMemo(() => renderDiff(diffBlocks(preview.before, preview.after), { titleOf }), [preview, titleOf]);
  useEffect(() => {
    onReady(preview);
    return () => onReady(null);
  }, [preview, onReady]);
  return <DiffEditor blocks={rendered.blocks} marks={rendered.marks} testId="selection-ai-preview" />;
}
