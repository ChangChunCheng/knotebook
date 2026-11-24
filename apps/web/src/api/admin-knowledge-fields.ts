import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { KNOWLEDGE_FIELDS_QUERY_ROOT, type AdminKnowledgeFieldsDto, type SiteKnowledgeFieldsInput } from "@knotebook/shared";
import { api } from "./client";

export const ADMIN_KNOWLEDGE_FIELDS_QUERY_KEY = ["admin", "knowledge-fields"] as const;

export function fetchAdminKnowledgeFields(): Promise<AdminKnowledgeFieldsDto> {
  return api<AdminKnowledgeFieldsDto>("/api/admin/knowledge-fields");
}

export function useAdminKnowledgeFields(): UseQueryResult<AdminKnowledgeFieldsDto> {
  return useQuery({
    queryKey: ADMIN_KNOWLEDGE_FIELDS_QUERY_KEY,
    queryFn: fetchAdminKnowledgeFields,
  });
}

export function saveSiteKnowledgeFields(input: SiteKnowledgeFieldsInput): Promise<AdminKnowledgeFieldsDto> {
  return api<AdminKnowledgeFieldsDto>("/api/admin/knowledge-fields", { method: "PUT", body: JSON.stringify(input) });
}

export function useSaveSiteKnowledgeFields(): UseMutationResult<AdminKnowledgeFieldsDto, unknown, SiteKnowledgeFieldsInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveSiteKnowledgeFields,
    onSuccess: (saved) => {
      queryClient.setQueryData(ADMIN_KNOWLEDGE_FIELDS_QUERY_KEY, saved);
      void queryClient.invalidateQueries({ queryKey: [KNOWLEDGE_FIELDS_QUERY_ROOT] });
    },
  });
}
