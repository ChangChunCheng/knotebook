import { useOutletContext } from "react-router";
import type { GroupDto } from "@knotebook/shared";

/**
 * The group `GroupModal` already resolved via `useGroups()`. Always set: sections render only after the group resolves (`GroupModal` draws
 * loading, error and not-found itself). Own file so the lazy `GroupSections` needn't import `GroupModal.tsx` (entry bundle).
 */
export interface GroupOutletContext {
  group: GroupDto;
}

export function useGroupOutlet(): GroupDto {
  return useOutletContext<GroupOutletContext>().group;
}
