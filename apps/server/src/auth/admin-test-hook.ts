/** Test seam (not injected in production): a second demote can be inserted after the locks and count, before the write. */
export type AdminRacePoint =
  "demote-locked";

export type AdminTestHook = (point: AdminRacePoint, ctx: { targetId: string }) => Promise<void>;
