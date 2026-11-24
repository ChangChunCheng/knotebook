import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { KNOWLEDGE_MEMBERS_LOOKUP_MAX, type KnowledgeMembersDto, type KnowledgeMembersRequest } from "@knotebook/shared";
import { api } from "./client";

export interface KnowledgeMemberName {
  handle: string;
  displayName: string;
}

/** `answered`: a lookup came back, so an id missing from the map is known not to exist. */
export type KnowledgeMemberNames = ReadonlyMap<string, KnowledgeMemberName> & { readonly answered: boolean };

// The endpoint refuses the whole body when one entry is longer than this; such a value can't be a handle or a user id anyway.
const LOOKUP_VALUE_MAX = 200;
const STALE_MS = 60_000;

function batches(values: readonly string[]): string[][] {
  const unique = [...new Set(values.filter((v) => v !== "" && v.length <= LOOKUP_VALUE_MAX))];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += KNOWLEDGE_MEMBERS_LOOKUP_MAX) out.push(unique.slice(i, i + KNOWLEDGE_MEMBERS_LOOKUP_MAX));
  return out;
}

function lookup(body: KnowledgeMembersRequest, signal?: AbortSignal): Promise<KnowledgeMembersDto> {
  return api<KnowledgeMembersDto>("/api/knowledge/members", { method: "POST", body: JSON.stringify(body), signal });
}

async function namesOf(noteId: string, ids: readonly string[], signal?: AbortSignal): Promise<Map<string, KnowledgeMemberName>> {
  const out = new Map<string, KnowledgeMemberName>();
  const answers = await Promise.all(batches(ids).map((part) => lookup({ noteId, ids: part }, signal)));
  for (const dto of answers) for (const u of dto.byId) out.set(u.id, { handle: u.handle, displayName: u.displayName });
  return out;
}

/** Keyed by the lowercased token. */
export async function fetchKnowledgeMemberIds(noteId: string, tokens: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  const answers = await Promise.all(batches(tokens.map((t) => t.toLowerCase())).map((part) => lookup({ noteId, tokens: part }, signal)));
  for (const dto of answers) for (const { token, id } of dto.byToken) out.set(token.toLowerCase(), id);
  return out;
}

export async function fetchKnowledgeMemberHandles(noteId: string, ids: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, string>> {
  const names = await namesOf(noteId, ids, signal);
  return new Map([...names].map(([id, n]) => [id, n.handle]));
}

const EMPTY: readonly string[] = [];

export function useKnowledgeMemberNames(noteId: string | null, ids: readonly string[]): KnowledgeMemberNames {
  const key = useMemo(() => [...new Set(ids.filter((id) => id !== ""))].sort(), [ids]);
  const wanted = noteId !== null && noteId !== "" && key.length > 0;
  const query = useQuery({
    queryKey: ["knowledge-members", noteId, wanted ? key : EMPTY],
    queryFn: ({ signal }) => namesOf(noteId!, key, signal),
    enabled: wanted,
    staleTime: STALE_MS,
    retry: 1,
  });
  const { data } = query;
  return useMemo(() => Object.assign(new Map(data ?? []), { answered: wanted && data !== undefined }), [data, wanted]);
}
