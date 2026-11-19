import { useCallback, useEffect, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import {
  orderBySeen,
  presenceCursor,
  presencePeople,
  presenceSignature,
  type PresenceKey,
  type PresencePerson,
} from "./people";

/**
 * y-protocols emits awareness `change` only when state content differs (heartbeats emit only `update`); several changes in
 * one frame are merged into one recompute. An unchanged signature skips setState, so cursor movement doesn't redraw the
 * avatars; clicks read live state via `cursorOf`.
 */

const EMPTY: PresencePerson[] = [];

interface Track {
  awareness: Awareness | null;
  userId: string | null;
  seen: Map<PresenceKey, number>;
  nextSeq: number;
  signature: string;
}

function compute(awareness: Awareness | null, userId: string | null, seen: ReadonlyMap<PresenceKey, number>, nextSeq: number) {
  const listed = awareness === null || userId === null ? EMPTY : presencePeople(awareness.getStates(), awareness.clientID, userId);
  const ordered = orderBySeen(seen, listed, nextSeq);
  return { ...ordered, signature: presenceSignature(ordered.people) };
}

export function usePresencePeople(
  awareness: Awareness | null,
  myUserId: string | null,
): { people: PresencePerson[]; cursorOf: (key: PresenceKey) => unknown | null } {
  // First paint computes directly instead of waiting a frame; seen/nextSeq go into the ref from the same computation.
  const [initial] = useState(() => compute(awareness, myUserId, new Map(), 0));
  const trackRef = useRef<Track>({
    awareness,
    userId: myUserId,
    seen: initial.seen,
    nextSeq: initial.nextSeq,
    signature: initial.signature,
  });
  const [people, setPeople] = useState<PresencePerson[]>(initial.people);

  useEffect(() => {
    const track = trackRef.current;
    if (track.awareness !== awareness || track.userId !== myUserId) {
      track.awareness = awareness;
      track.userId = myUserId;
      track.seen = new Map();
      track.nextSeq = 0;
      track.signature = "";
    }
    let pending: number | null = null;
    const flush = () => {
      pending = null;
      const next = compute(awareness, myUserId, track.seen, track.nextSeq);
      track.seen = next.seen;
      track.nextSeq = next.nextSeq;
      if (next.signature === track.signature) return;
      track.signature = next.signature;
      setPeople(next.people);
    };
    // Changes may have landed between render and effect: recompute once synchronously (no setState if the signature is unchanged).
    flush();
    if (awareness === null || myUserId === null) return;
    const onChange = () => {
      if (pending === null) pending = requestAnimationFrame(flush);
    };
    awareness.on("change", onChange);
    return () => {
      awareness.off("change", onChange);
      if (pending !== null) cancelAnimationFrame(pending);
    };
  }, [awareness, myUserId]);

  const cursorOf = useCallback(
    (key: PresenceKey) =>
      awareness === null || myUserId === null
        ? null
        : presenceCursor(awareness.getStates(), key, awareness.clientID, myUserId),
    [awareness, myUserId],
  );

  return { people: awareness === null || myUserId === null ? EMPTY : people, cursorOf };
}
