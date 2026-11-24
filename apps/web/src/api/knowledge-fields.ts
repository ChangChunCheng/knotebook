import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_KNOWLEDGE_FIELD_VIEW, KNOWLEDGE_FIELDS_QUERY_ROOT, type KnowledgeFieldView, type KnowledgeFieldsDto } from "@knotebook/shared";
import { ApiFail, api } from "./client";

export type KnowledgeFieldsStatus = "loading" | "ready" | "error";
export type KnowledgeFieldsTarget = { noteId: string } | { groupId: string } | { personal: true };

const STALE_MS = 60_000;

function fieldsPath(target: KnowledgeFieldsTarget): string {
  if ("noteId" in target) return `/api/knowledge/fields?note=${encodeURIComponent(target.noteId)}`;
  if ("groupId" in target) return `/api/knowledge/fields?group=${encodeURIComponent(target.groupId)}`;
  return "/api/knowledge/fields";
}

export function knowledgeFieldsKey(target: KnowledgeFieldsTarget): readonly unknown[] {
  if ("noteId" in target) return [KNOWLEDGE_FIELDS_QUERY_ROOT, "note", target.noteId];
  if ("groupId" in target) return [KNOWLEDGE_FIELDS_QUERY_ROOT, "group", target.groupId];
  return [KNOWLEDGE_FIELDS_QUERY_ROOT, "personal"];
}

/** loading and error both carry DEFAULT_KNOWLEDGE_FIELD_VIEW; callers decide by status. */
export function useKnowledgeFields(target: KnowledgeFieldsTarget): { view: KnowledgeFieldView; status: KnowledgeFieldsStatus } {
  const queryClient = useQueryClient();
  // A 4xx (no access, unknown space) will not change on its own, so it is not retried.
  const retry = useMemo(() => {
    const base = queryClient.getDefaultOptions().queries?.retry ?? 3;
    return (failureCount: number, error: Error) => {
      if (error instanceof ApiFail && error.status >= 400 && error.status < 500) return false;
      if (typeof base === "function") return base(failureCount, error);
      return typeof base === "number" ? failureCount < base : base;
    };
  }, [queryClient]);
  const path = fieldsPath(target);
  const query = useQuery({
    queryKey: knowledgeFieldsKey(target),
    queryFn: ({ signal }) => api<KnowledgeFieldsDto>(path, { signal }),
    staleTime: STALE_MS,
    retry,
  });
  const { data, isError } = query;
  return useMemo(
    () => (data ? { view: data, status: "ready" as const } : { view: DEFAULT_KNOWLEDGE_FIELD_VIEW, status: isError ? ("error" as const) : ("loading" as const) }),
    [data, isError],
  );
}
