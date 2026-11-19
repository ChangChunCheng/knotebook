import { useVersionList, type VersionTarget } from "@/api/versions";
import { useVersions } from "@/lib/versions-context";
import { versionLabel } from "./version-labels";

/** Label "name (short id)" of the preview/compare target (#272): the list row when the list still has this version (a rename shows at once); otherwise (filtered out by "manual only", or on a page not loaded yet) the `target.name` recorded at selection. Shares the list query cache (same query key) with panel and compare dropdown, so no extra request. */
export function useTargetLabel(target: VersionTarget | null): string {
  const { noteId, kindFilter } = useVersions();
  const list = useVersionList(noteId ?? "", target !== null, kindFilter);
  if (target === null) return "";
  const row = list.data?.pages.flatMap((p) => p.versions).find((r) => r.id === target.id);
  return versionLabel(row ?? target);
}
