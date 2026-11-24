/**
 * Aggregate lazy module for the seven site admin sections (#247): the seven `lazy()` calls in `App.tsx` import this one module
 * so Rollup emits a single `AdminSections-<hash>.js` (`ADMINSECTIONS_RE` in `scripts/check-bundle-size.mjs` pins it). The
 * `AdminModal` shell is a layout route in the entry chunk and the sections are lazy elements in its `<Outlet/>`, like
 * `SettingsModal`; errors go to `LazyRouteErrorBoundary` (inline frame, `chunk="admin"`). All seven share that
 * reload budget, which converges only if no lazy module renders only after another has mounted (see `ErrorBoundary.tsx`);
 * as sibling route elements in one chunk they satisfy that.
 * Its components must not be statically imported by any entry-chunk module, or Rollup merges them back into the entry
 * and the chunk disappears. The storage section (`SettingsStorageSection`) also renders the site versions settings
 * (`SiteVersionsGroups`) and site trash settings (`SiteTrashGroup`) after the plan table.
 */
export { SettingsUsersSection as AdminUsersSection } from "@/settings/SettingsUsersSection";
export { SettingsAdminGroupsSection as AdminGroupsSection } from "@/settings/SettingsAdminGroupsSection";
export { SettingsAuthSection as AdminLoginSection } from "@/settings/SettingsAuthSection";
export { SettingsStorageSection as AdminStorageSection } from "@/settings/SettingsStorageSection";
export { SettingsAiSection as AdminAiSection } from "@/settings/SettingsAiSection";
export { SettingsKnowledgeFieldsSection as AdminKnowledgeFieldsSection } from "@/settings/SettingsKnowledgeFieldsSection";
export { SettingsLimitsSection as AdminLimitsSection } from "@/settings/SettingsLimitsSection";
