import { createContext, useContext, type RefObject } from "react";
import type { CollabState } from "@/collab/connection";

/** Deleting from the sidebar ⋮ must share NotePage's `leavingRef` / collab state (see the NoteMenu.tsx header). */
export interface NotePageControls {
  noteId: string;
  state: CollabState;
  leavingRef: RefObject<boolean>;
  openEdits: () => void;
}

export const NotePageControlsContext = createContext<NotePageControls | null>(null);

export interface OpenEditsState {
  openEdits: true;
}

export function useNotePageControls(): NotePageControls | null {
  return useContext(NotePageControlsContext);
}
