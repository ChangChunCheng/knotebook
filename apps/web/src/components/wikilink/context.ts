import { createContext } from "react";
import type { PublicLinkDto } from "@knotebook/shared";

/**
 * `member` (default: editor, viewer, version preview) takes titles from the `["notes"]` cache (`useNotes`). `public` must not call
 * `useNotes()` (anonymous `GET /api/notes` is 401); its titles and URLs come only from the public payload's `links`.
 * Hooks can't be called conditionally, so `WikilinkInline` dispatches on this context to two components.
 */
export type WikilinkMode = { mode: "member" } | { mode: "public"; links: ReadonlyMap<string, PublicLinkDto> };

export const WikilinkContext = createContext<WikilinkMode>({ mode: "member" });
