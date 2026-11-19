import { describe, it, expect } from "vitest";
import type { AiProviderRow } from "../../src/ai/runtime.js";
import { resolveActionModel, type AiModelRow, type AiSnapshot } from "../../src/ai/resolve.js";

function provider(overrides: Partial<AiProviderRow> = {}): AiProviderRow {
  return {
    id: "provider-1",
    name: "Test Provider",
    type: "openai_compatible",
    baseUrl: "https://api.example.com",
    apiKeyEncrypted: null,
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function model(overrides: Partial<AiModelRow> = {}): AiModelRow {
  return {
    id: "model-1",
    providerId: "provider-1",
    modelId: "gpt-test",
    displayName: "Test Model",
    purpose: "chat",
    isDefault: false,
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function snapshot(models: AiModelRow[], providers: AiProviderRow[]): AiSnapshot {
  return { models, providers };
}

describe("resolveActionModel (in-memory decision)", () => {
  it("usable bound model -> returned directly, other candidates not considered", () => {
    const bound = model({ id: "m-bound", providerId: "provider-1" });
    // The isDefault entry is deliberately ordered first: if the helper also ran a usable bound model through the fallback
    // ordering, this test would catch it (bound must be returned directly, never sorted).
    const other = model({ id: "m-other", providerId: "provider-1", isDefault: true });
    const snap = snapshot([bound, other], [provider()]);
    const result = resolveActionModel({ modelId: "m-bound" }, snap);
    expect(result?.model.id).toBe("m-bound");
    expect(result?.provider.id).toBe("provider-1");
  });

  it("bound model exists but is disabled -> falls back to another usable chat model", () => {
    const bound = model({ id: "m-bound", enabled: false });
    const fallback = model({ id: "m-fallback" });
    const snap = snapshot([bound, fallback], [provider()]);
    const result = resolveActionModel({ modelId: "m-bound" }, snap);
    expect(result?.model.id).toBe("m-fallback");
  });

  it("bound model missing (e.g. deleted, dangling modelId) -> falls back", () => {
    const fallback = model({ id: "m-fallback" });
    const snap = snapshot([fallback], [provider()]);
    const result = resolveActionModel({ modelId: "no-such-model" }, snap);
    expect(result?.model.id).toBe("m-fallback");
  });

  it("fallback: prefers isDefault among candidates (even with a later createdAt)", () => {
    const early = model({ id: "m-early", createdAt: new Date("2026-01-01T00:00:00Z") });
    const preferredDefault = model({ id: "m-default", isDefault: true, createdAt: new Date("2026-06-01T00:00:00Z") });
    const snap = snapshot([early, preferredDefault], [provider()]);
    const result = resolveActionModel({ modelId: null }, snap);
    expect(result?.model.id).toBe("m-default");
  });

  it("fallback: no default -> earliest createdAt wins", () => {
    const later = model({ id: "m-later", createdAt: new Date("2026-06-01T00:00:00Z") });
    const earlier = model({ id: "m-earlier", createdAt: new Date("2026-01-01T00:00:00Z") });
    const snap = snapshot([later, earlier], [provider()]);
    const result = resolveActionModel({ modelId: null }, snap);
    expect(result?.model.id).toBe("m-earlier");
  });

  it("all disabled (the model itself or its provider) -> null", () => {
    const disabledModel = model({ id: "m-1", enabled: false });
    const okModelBadProvider = model({ id: "m-2", providerId: "provider-2" });
    const snap = snapshot([disabledModel, okModelBadProvider], [provider(), provider({ id: "provider-2", enabled: false })]);
    const result = resolveActionModel({ modelId: null }, snap);
    expect(result).toBeNull();
  });

  it("disabled provider makes its model unusable (also for the bound model, which then falls back)", () => {
    const boundOnDisabledProvider = model({ id: "m-bound", providerId: "provider-2" });
    const fallback = model({ id: "m-fallback", providerId: "provider-1" });
    const snap = snapshot([boundOnDisabledProvider, fallback], [provider(), provider({ id: "provider-2", enabled: false })]);
    const result = resolveActionModel({ modelId: "m-bound" }, snap);
    expect(result?.model.id).toBe("m-fallback");
  });

  it("fallback candidates consider only purpose='chat'; non-chat models are excluded", () => {
    const embedding = model({ id: "m-embed", purpose: "embedding", isDefault: true });
    const chat = model({ id: "m-chat", purpose: "chat" });
    const snap = snapshot([embedding, chat], [provider()]);
    const result = resolveActionModel({ modelId: null }, snap);
    expect(result?.model.id).toBe("m-chat");
  });

  it("returned provider matches model.providerId (guards against mixing sources)", () => {
    const m = model({ id: "m-1", providerId: "provider-9" });
    const snap = snapshot([m], [provider({ id: "provider-9" })]);
    const result = resolveActionModel({ modelId: null }, snap);
    expect(result?.provider.id).toBe(result?.model.providerId);
  });
});
