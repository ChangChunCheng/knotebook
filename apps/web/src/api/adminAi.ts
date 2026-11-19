import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { AdminAiActionDto, AdminAiModelDto, AdminAiProviderDto } from "@knotebook/shared";
import { api } from "./client";

/** All three keys share the `["admin-ai"]` prefix that `invalidateAdminAi` relies on. */
export const ADMIN_AI_PROVIDERS_QUERY_KEY = ["admin-ai", "providers"] as const;
export const ADMIN_AI_MODELS_QUERY_KEY = ["admin-ai", "models"] as const;
export const ADMIN_AI_ACTIONS_QUERY_KEY = ["admin-ai", "actions"] as const;

export function useAdminAiProviders(): UseQueryResult<AdminAiProviderDto[]> {
  return useQuery({
    queryKey: ADMIN_AI_PROVIDERS_QUERY_KEY,
    queryFn: () => api<{ providers: AdminAiProviderDto[] }>("/api/admin/ai/providers").then((body) => body.providers),
  });
}

export function useAdminAiModels(): UseQueryResult<AdminAiModelDto[]> {
  return useQuery({
    queryKey: ADMIN_AI_MODELS_QUERY_KEY,
    queryFn: () => api<{ models: AdminAiModelDto[] }>("/api/admin/ai/models").then((body) => body.models),
  });
}

export function useAdminAiActions(): UseQueryResult<AdminAiActionDto[]> {
  return useQuery({
    queryKey: ADMIN_AI_ACTIONS_QUERY_KEY,
    queryFn: () => api<{ actions: AdminAiActionDto[] }>("/api/admin/ai/actions").then((body) => body.actions),
  });
}

/** Also invalidates `["ai-actions"]` (the list `AiSession` reads) so admin changes apply without a reload. */
function invalidateAdminAi(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["admin-ai"] });
  void queryClient.invalidateQueries({ queryKey: ["ai-actions"] });
}

export interface CreateAiProviderBody {
  name: string;
  type: "openai_compatible" | "anthropic";
  baseUrl: string;
  apiKey?: string;
}

export interface PatchAiProviderBody {
  name?: string;
  type?: "openai_compatible" | "anthropic";
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
}

export function useCreateAiProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAiProviderBody) =>
      api<AdminAiProviderDto>("/api/admin/ai/providers", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}

export function usePatchAiProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchAiProviderBody }) =>
      api<AdminAiProviderDto>(`/api/admin/ai/providers/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}

export function useDeleteAiProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/admin/ai/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}

/** `onSettled`, not `onSuccess`: only a test that fails on an undecryptable key marks the provider degraded, and degraded
 * providers get 503 before the test runs, so only the error path changes the badge. Success still invalidates, like every
 * admin-ai mutation. */
export function useTestAiProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/admin/ai/providers/${encodeURIComponent(id)}/test`, { method: "POST" }),
    onSettled: () => invalidateAdminAi(queryClient),
  });
}

export interface CreateAiModelBody {
  providerId: string;
  modelId: string;
  displayName: string;
  isDefault?: boolean;
  enabled?: boolean;
}

export interface PatchAiModelBody {
  modelId?: string;
  displayName?: string;
  isDefault?: boolean;
  enabled?: boolean;
}

export function useCreateAiModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAiModelBody) =>
      api<AdminAiModelDto>("/api/admin/ai/models", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}

export function usePatchAiModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchAiModelBody }) =>
      api<AdminAiModelDto>(`/api/admin/ai/models/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}

export function useDeleteAiModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/admin/ai/models/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}

export interface CreateAiActionBody {
  name: string;
  systemPrompt: string;
  userTemplate: string;
  modelId?: string | null;
  applyMode: "direct" | "preview";
  sortOrder?: number;
  enabled?: boolean;
}

export interface PatchAiActionBody {
  name?: string;
  systemPrompt?: string;
  userTemplate?: string;
  modelId?: string | null;
  applyMode?: "direct" | "preview";
  sortOrder?: number;
  enabled?: boolean;
}

export function useCreateAiAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAiActionBody) =>
      api<AdminAiActionDto>("/api/admin/ai/actions", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}

export function usePatchAiAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchAiActionBody }) =>
      api<AdminAiActionDto>(`/api/admin/ai/actions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}

export function useDeleteAiAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/admin/ai/actions/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}
