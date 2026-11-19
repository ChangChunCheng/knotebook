import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/auth/useSession";
import { syncFillerUser } from "./filler-user";

// Thin shell in AppShell: the filler loads only when there is something to fill, and its state survives remounts.
export function AvatarDisplayFiller() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const userId = user?.id;
  const avatar = user?.avatar;
  const pending = avatar?.pending === true;
  const avatarId = avatar?.id;
  const avatarVersion = avatar?.v;

  // Must run before the effect below, so a previous user's queue and failures aren't kept for the next user.
  useEffect(() => {
    syncFillerUser(userId);
  }, [userId]);

  useEffect(() => {
    if (!pending || avatarId === undefined || avatarVersion === undefined) return;
    void import("./filler-runtime").then(runtime => runtime.startFill({ id: avatarId, v: avatarVersion }, queryClient));
  }, [pending, avatarId, avatarVersion, queryClient]);

  return null;
}
