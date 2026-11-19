import type { QueryClient } from "@tanstack/react-query";
import { fetchAvatarOriginal, invalidateAvatarQueries, putAvatarDisplay } from "@/api/avatars";
import { configureFiller, enqueueFill, type FillTarget } from "./display-filler";

// Loaded only via dynamic import() or the lazy settings page, keeping api/avatars out of the main bundle.
export function configureForClient(queryClient: QueryClient): void {
  configureFiller({
    fetchOriginal: fetchAvatarOriginal,
    putDisplay: putAvatarDisplay,
    invalidate: () => void invalidateAvatarQueries(queryClient),
  });
}

export function startFill(target: FillTarget, queryClient: QueryClient): void {
  configureForClient(queryClient);
  enqueueFill(target);
}
