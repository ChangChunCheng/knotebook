/**
 * Sole lazy entry for the version history UI: reference only via `lazy(() => import(...))`; any static import makes Rollup move the imported components (and their deps, e.g. `diff`) into the caller's chunk.
 * The guard is `VERSIONS_MARKERS` in `scripts/check-bundle-size.mjs` (a non-VersionsLazy chunk containing strings unique to these modules fails); when adding an exported module, add a marker for it.
 * `SelectionAiPreview` is an exception: it imports a value from `@/lib/version-diff`, so a static import moves `diff` too and the existing marker catches it; i18n-type markers only cover `versions.*` (`check-bundle-size.test.mjs`).
 */
export { VersionsPanel } from "./VersionsPanel";
export { VersionPreview, DiffEditor } from "./VersionPreview";
export { PreviewBanner } from "./PreviewBanner";
export { VersionsDialogs } from "./VersionsDialogs";
export { VersionsSheet } from "./VersionsSheet";
export { SelectionAiPreview } from "@/components/ai/SelectionAiPreview";
