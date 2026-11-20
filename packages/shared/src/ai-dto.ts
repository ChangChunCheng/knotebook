import type { AiActionKind } from "./ai.js";

export const AI_SSE_EVENTS = { delta: "delta", done: "done", error: "error" } as const;
export interface AiSseErrorPayload {
  code: string;
  message: string;
}

export interface AiActionDto {
  id: string;
  name: string;
  applyMode: "direct" | "preview";
  kind: AiActionKind;
}

export interface AdminAiProviderDto {
  id: string;
  name: string;
  type: "openai_compatible" | "anthropic";
  baseUrl: string;
  enabled: boolean;
  hasKey: boolean;
  degraded: boolean;
  createdAt: string;
}

export interface AdminAiModelDto {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  purpose: "chat";
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface AdminAiActionDto {
  id: string;
  name: string;
  systemPrompt: string;
  userTemplate: string;
  modelId: string | null;
  applyMode: "direct" | "preview";
  sortOrder: number;
  enabled: boolean;
  builtin: boolean;
  kind: AiActionKind;
}
