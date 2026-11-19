import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AdminAiActionDto, AdminAiModelDto, AdminAiProviderDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { clickOutside } from "@/test/outside-click";
import { chooseOption, displayedLabel, optionLabels, selectedValue } from "@/test/ui-select";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { SettingsAiSection } from "./SettingsAiSection";

// Same convention: mock global fetch so the real admin-ai hooks (`@/api/adminAi`, react-query) hit fake responses, without mocking the hooks themselves - see ShareDialog.test.tsx / NoteList.test.tsx.
// `SettingsAiSection` takes no router/session context (unlike `SettingsUsersSection`,
// which needs `useSession` to tell "my own row"), so it renders standalone without going through `AppRoutes`.

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const PROVIDER_A: AdminAiProviderDto = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Anthropic Prod",
  type: "anthropic",
  baseUrl: "https://api.anthropic.com",
  enabled: true,
  hasKey: true,
  degraded: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const PROVIDER_B: AdminAiProviderDto = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "Local Ollama",
  type: "openai_compatible",
  baseUrl: "http://host:11434/v1",
  enabled: true,
  hasKey: false,
  degraded: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const MODEL_A1: AdminAiModelDto = {
  id: "33333333-3333-3333-3333-333333333333",
  providerId: PROVIDER_A.id,
  modelId: "claude-3-5-sonnet",
  displayName: "Claude Sonnet",
  purpose: "chat",
  isDefault: true,
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const MODEL_B1: AdminAiModelDto = {
  id: "44444444-4444-4444-4444-444444444444",
  providerId: PROVIDER_B.id,
  modelId: "llama3",
  displayName: "Llama 3",
  purpose: "chat",
  isDefault: false,
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const ACTION_BUILTIN: AdminAiActionDto = {
  id: "55555555-5555-5555-5555-555555555555",
  name: "Improve writing",
  systemPrompt: "You are a helpful writing assistant.",
  userTemplate: "Improve the following text:\n{{text}}",
  modelId: null,
  applyMode: "direct",
  sortOrder: 0,
  enabled: true,
  builtin: true,
  kind: "quick",
};

const ACTION_CUSTOM: AdminAiActionDto = {
  id: "66666666-6666-6666-6666-666666666666",
  name: "Custom action",
  systemPrompt: "You are a helpful assistant.",
  userTemplate: "Do something with:\n{{text}}",
  modelId: null,
  applyMode: "preview",
  sortOrder: 1,
  enabled: true,
  builtin: false,
  kind: "quick",
};

const ACTION_INSTRUCT: AdminAiActionDto = {
  id: "58ef60fd-e99e-4f19-aa57-6fea5e652749",
  name: "Instruct",
  systemPrompt: "You are an expert editor.",
  userTemplate: "{{instruction}}\n{{focus}}\n{{text}}",
  modelId: null,
  applyMode: "preview",
  sortOrder: 4,
  enabled: true,
  builtin: true,
  kind: "instruct",
};

function defaultGetHandlers(
  overrides: Partial<{ providers: AdminAiProviderDto[]; models: AdminAiModelDto[]; actions: AdminAiActionDto[] }> = {},
) {
  const providers = overrides.providers ?? [PROVIDER_A, PROVIDER_B];
  const models = overrides.models ?? [MODEL_A1, MODEL_B1];
  const actions = overrides.actions ?? [ACTION_BUILTIN, ACTION_CUSTOM];
  return (url: string, method: string): Response | null => {
    if (url === "/api/groups" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/admin/ai/providers" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ providers }) });
    }
    if (url === "/api/admin/ai/models" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ models }) });
    }
    if (url === "/api/admin/ai/actions" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ actions }) });
    }
    return null;
  };
}

function renderSection(
  fetchMock: ReturnType<typeof vi.fn>,
  queryClient: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsAiSection />
      <Toaster />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("SettingsAiSection (provider / model / action three-layer CRUD)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { dialog: "Add provider", open: () => screen.getByRole("button", { name: "Add provider" }) },
    { dialog: "Edit provider", open: () => screen.getAllByRole("button", { name: "Edit" })[0] },
    { dialog: "Add model", open: () => screen.getByRole("button", { name: "Add model" }) },
    { dialog: "Edit model", open: () => screen.getAllByRole("button", { name: "Edit" })[1] },
    { dialog: "Add action", open: () => screen.getByRole("button", { name: "Add action" }) },
    { dialog: "Edit action", open: () => screen.getAllByRole("button", { name: "Edit" }).at(-1)! },
  ])("\"$dialog\" dialog: clicking outside doesn't close it and typed content remains (form guard)", async ({ dialog, open }) => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [PROVIDER_A], models: [MODEL_A1], actions: [ACTION_CUSTOM] })(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    renderSection(fetchMock);
    await waitFor(() => expect(screen.getByText(ACTION_CUSTOM.name)).toBeInTheDocument());
    fireEvent.click(open());
    const dlg = await screen.findByRole("dialog", { name: dialog });
    const first = within(dlg).getAllByRole("textbox")[0];
    fireEvent.change(first, { target: { value: "KEEP-ME" } });
    await clickOutside();
    expect(screen.getByRole("dialog", { name: dialog })).toBeInTheDocument();
    expect(within(dlg).getAllByRole("textbox")[0]).toHaveValue("KEEP-ME");
  });

  it("three-layer list renders: providers / embedded models / actions", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers()(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(PROVIDER_A.name)).toBeInTheDocument());
    expect(screen.getByText(PROVIDER_B.name)).toBeInTheDocument();
    // The model name appears twice: the provider row's Models column plus the model sub-table in the detail row.
    expect(screen.getAllByText(MODEL_A1.displayName)).toHaveLength(2);
    expect(screen.getByText(MODEL_A1.modelId)).toBeInTheDocument();
    expect(screen.getAllByText(MODEL_B1.displayName)).toHaveLength(2);
    expect(screen.getByText(ACTION_BUILTIN.name)).toBeInTheDocument();
    expect(screen.getByText(ACTION_CUSTOM.name)).toBeInTheDocument();
  });

  it("adding a provider (with apiKey) submits a camelCase body", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === "/api/admin/ai/providers" && method === "POST") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ ...PROVIDER_A, id: "p-new" }) }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText("No providers yet.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => expect(screen.getByLabelText("Name")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Provider" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.anthropic.com" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-test-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([reqUrl, reqInit]) => String(reqUrl) === "/api/admin/ai/providers" && (reqInit as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeDefined();
      const [, init] = call as [RequestInfo, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({
        name: "New Provider",
        type: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "sk-test-123",
      });
    });
  });

  it("baseUrl with credentials -> clear error on both add and edit, request not sent", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [PROVIDER_A], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    renderSection(fetchMock);
    const message = "The Base URL can't contain a username or password. Put the credentials in the API key field.";

    await waitFor(() => expect(screen.getByText(PROVIDER_A.name)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Cred" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://user:pass@example.com/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const input = await screen.findByLabelText("Base URL");
    fireEvent.change(input, { target: { value: "https://user@example.com/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(message)).toBeInTheDocument();

    const writes = fetchMock.mock.calls.filter(([, init]) => ["POST", "PATCH"].includes(String((init as RequestInit | undefined)?.method)));
    expect(writes).toHaveLength(0);
  });

  it("apiKey already set -> the edit dialog shows an overwrite placeholder; leaving it blank sends a PATCH without the apiKey field", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [PROVIDER_A], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === `/api/admin/ai/providers/${PROVIDER_A.id}` && method === "PATCH") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(PROVIDER_A) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(PROVIDER_A.name)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const apiKeyInput = await screen.findByLabelText("API key");
    expect(apiKeyInput).toHaveAttribute("placeholder", "Already set — enter a new value to overwrite");
    expect(apiKeyInput).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([reqUrl, reqInit]) =>
          String(reqUrl) === `/api/admin/ai/providers/${PROVIDER_A.id}` && (reqInit as RequestInit | undefined)?.method === "PATCH",
      );
      expect(call).toBeDefined();
      const [, init] = call as [RequestInfo, RequestInit];
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty("apiKey");
      expect(body).toEqual({ name: PROVIDER_A.name, type: PROVIDER_A.type, baseUrl: PROVIDER_A.baseUrl });
    });
  });

  it("changing base_url warns \"this clears the key\"; entering a new key in the same edit removes the warning (issue #46)", async () => {
    // Warn in advance: otherwise the user would first see the provider suddenly stop working before learning what happened.
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [PROVIDER_A], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);
    await waitFor(() => expect(screen.getByText(PROVIDER_A.name)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const notice = /Changing the Base URL clears the stored API key/;
    expect(screen.queryByText(notice)).not.toBeInTheDocument();

    const baseUrlInput = await screen.findByLabelText("Base URL");
    fireEvent.change(baseUrlInput, { target: { value: "http://elsewhere.example.com" } });
    expect(screen.getByText(notice)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-new" } });
    expect(screen.queryByText(notice)).not.toBeInTheDocument();

    // Delete it again (or leave only whitespace) -> the warning returns. All three conditions are derived values recomputed on every render;
    // turning them into a useState + useEffect snapshot would silently break here.
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "   " } });
    expect(screen.getByText(notice)).toBeInTheDocument();
  });

  it("a provider without a key is visible in that provider's detail row; one with a key doesn't show it (#46)", async () => {
    // A cleared key used to have no UI representation: the provider row doesn't show hasKey and the degraded red text disappears at the same time (no key doesn't count as "can't decrypt").
    // The documented "shows as having no key" behavior depends on this hint.
    // Use the existing PROVIDER_B (Local Ollama, hasKey:false): inventing an id that collides with PROVIDER_A would duplicate React keys and DOM ids,
    // and the "exactly one" assertion would rest on undefined reconciliation behavior.
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [PROVIDER_A, PROVIDER_B], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);
    await waitFor(() => expect(screen.getByText(PROVIDER_B.name)).toBeInTheDocument());

    // Verify **which provider's detail row** carries the hint; counting isn't enough (inverting the condition to `hasKey && !degraded` would put the hint on the provider that has a key and hide it on the one without, and a count alone wouldn't notice).
    // A provider's description line is in the detail row right after its data row ("<name> details").
    const noKeyCard = screen.getByRole("row", { name: `${PROVIDER_B.name} details` });
    const hasKeyCard = screen.getByRole("row", { name: `${PROVIDER_A.name} details` });
    expect(within(noKeyCard).getByText(/No API key stored/)).toBeInTheDocument();
    expect(within(hasKeyCard).queryByText(/No API key stored/)).not.toBeInTheDocument();
  });

  it("a provider without a key changing its URL doesn't show \"this clears the key\" (there's nothing to clear)", async () => {
    const noKey = { ...PROVIDER_A, hasKey: false };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [noKey], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);
    await waitFor(() => expect(screen.getByText(noKey.name)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    fireEvent.change(await screen.findByLabelText("Base URL"), { target: { value: "http://localhost:11435/v1" } });
    expect(screen.queryByText(/Changing the Base URL clears/)).not.toBeInTheDocument();
  });

  it("degraded provider shows a warning and a re-enter hint", async () => {
    const degradedProvider: AdminAiProviderDto = { ...PROVIDER_A, degraded: true };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [degradedProvider], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(degradedProvider.name)).toBeInTheDocument());
    expect(screen.getByText(/Degraded/)).toBeInTheDocument();
    expect(screen.getByText(/Enter the API key again to restore it/)).toBeInTheDocument();
  });

  it("test connection failure -> still invalidates (onSettled, not onSuccess - the degraded badge must not go stale)", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [PROVIDER_A], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === `/api/admin/ai/providers/${PROVIDER_A.id}/test` && method === "POST") {
        return Promise.resolve(
          fakeResponse({
            ok: false,
            status: 503,
            json: () => Promise.resolve({ error: { code: "provider_unavailable", message: "此 provider 目前無法使用" } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    renderSection(fetchMock, queryClient);

    await waitFor(() => expect(screen.getByText(PROVIDER_A.name)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() => expect(screen.getByText("AI provider is unavailable — ask an admin to re-enter the API key")).toBeInTheDocument());

    // Key point: a failed mutation still invalidates (the server adds to runtime.degraded only on the failure path; with onSuccess, the provider row and detail row that just became degraded wouldn't refresh until the next unrelated action).
    const keys = invalidateSpy.mock.calls.map(([arg]) => (arg as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(["admin-ai"]);
    expect(keys).toContainEqual(["ai-actions"]);
  });

  it("model isDefault shows a star badge", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [PROVIDER_A], models: [MODEL_A1], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getAllByText(MODEL_A1.displayName).length).toBeGreaterThan(0));
    expect(screen.getByTitle("Default")).toHaveTextContent("★");
  });

  it("409 model_taken -> the model form shows the error text", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [PROVIDER_A], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === "/api/admin/ai/models" && method === "POST") {
        return Promise.resolve(
          fakeResponse({
            ok: false,
            status: 409,
            json: () => Promise.resolve({ error: { code: "model_taken", message: "This provider already has that model." } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(PROVIDER_A.name)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));

    await waitFor(() => expect(screen.getByLabelText("Model ID")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "claude-3-5-sonnet" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Dup" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByText("This model already exists for the provider")).toBeInTheDocument());
  });

  it("builtin action has no delete button, custom action has one", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [], models: [], actions: [ACTION_BUILTIN, ACTION_CUSTOM] })(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(ACTION_BUILTIN.name)).toBeInTheDocument());
    const builtinRow = screen.getByRole("row", { name: ACTION_BUILTIN.name });
    const customRow = screen.getByRole("row", { name: ACTION_CUSTOM.name });
    expect(within(builtinRow).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(within(customRow).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("#263 Instruct edit dialog: no apply-mode control rendered, the submitted PATCH has no applyMode", async () => {
    let patchBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [], models: [], actions: [ACTION_INSTRUCT] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === `/api/admin/ai/actions/${ACTION_INSTRUCT.id}` && method === "PATCH") {
        patchBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ACTION_INSTRUCT) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(ACTION_INSTRUCT.name)).toBeInTheDocument());
    const row = screen.getByRole("row", { name: ACTION_INSTRUCT.name });
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit action" });
    expect(within(dialog).queryByLabelText("Apply mode")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patchBody).toBeDefined());
    expect(patchBody).not.toHaveProperty("applyMode");
  });

  it("#263 Instruct edit dialog: the template hint lists three placeholders (read only the hint line - the userTemplate textarea value is also in the dialog's textContent, so reading the whole dialog would match vacuously)", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [], models: [], actions: [ACTION_INSTRUCT] })(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(ACTION_INSTRUCT.name)).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("row", { name: ACTION_INSTRUCT.name })).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit action" });
    const hint = within(dialog).getByTestId("ai-action-edit-template-hint");
    expect(hint).toHaveTextContent("Must include {{instruction}} and {{text}}; {{focus}} is optional.");
    expect(hint).not.toHaveTextContent("placeholder for the selected text");
  });

  it("#263 counter-case: a quick action's edit dialog still has the apply-mode control", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [], models: [], actions: [ACTION_CUSTOM] })(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(ACTION_CUSTOM.name)).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("row", { name: ACTION_CUSTOM.name })).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit action" });
    expect(within(dialog).getByLabelText("Apply mode")).toBeInTheDocument();
    expect(within(dialog).getByTestId("ai-action-edit-template-hint")).toHaveTextContent("Must include a {{text}} placeholder for the selected text.");
  });

  it("userTemplate missing {{text}} -> 400 invalid_body, the form shows the error", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === "/api/admin/ai/actions" && method === "POST") {
        return Promise.resolve(
          fakeResponse({
            ok: false,
            status: 400,
            json: () => Promise.resolve({ error: { code: "invalid_body", message: "userTemplate must contain the {{text}} placeholder." } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText("No actions yet.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));

    await waitFor(() => expect(screen.getByLabelText("Name")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bad action" } });
    fireEvent.change(screen.getByLabelText("System prompt"), { target: { value: "You are helpful." } });
    fireEvent.change(screen.getByLabelText("User template"), { target: { value: "Rewrite this without placeholder" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByText("The request was malformed.")).toBeInTheDocument());
  });

  it("adding an action appends it last: the create body carries an incrementing sortOrder (regression)", async () => {
    // ACTION_BUILTIN.sortOrder=0, ACTION_CUSTOM.sortOrder=1. If the create body omitted `sortOrder`, the server's `sortOrder ?? 0` would give the new action the same 0 as ACTION_BUILTIN,
    // and the up/down buttons swapping equal values would do nothing, silently breaking ordering for the new action. This asserts the POST body carries `max(0,1)+1=2`, not omitted and not 0.
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [], models: [], actions: [ACTION_BUILTIN, ACTION_CUSTOM] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === "/api/admin/ai/actions" && method === "POST") {
        return Promise.resolve(
          fakeResponse({
            ok: true,
            status: 201,
            json: () => Promise.resolve({ ...ACTION_CUSTOM, id: "a-new", name: "New action", sortOrder: 2 }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(ACTION_CUSTOM.name)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));

    await waitFor(() => expect(screen.getByLabelText("Name")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New action" } });
    fireEvent.change(screen.getByLabelText("System prompt"), { target: { value: "You are helpful." } });
    fireEvent.change(screen.getByLabelText("User template"), { target: { value: "Do something with:\n{{text}}" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([reqUrl, reqInit]) => String(reqUrl) === "/api/admin/ai/actions" && (reqInit as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeDefined();
      const [, init] = call as [RequestInfo, RequestInit];
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body.sortOrder).toBe(2);
      expect(body.sortOrder).not.toBe(ACTION_BUILTIN.sortOrder);
      expect(body).toHaveProperty("sortOrder");
    });
  });

  it("adding an action: the model dropdown defaults to Auto, after picking a model the submitted body carries that model id; picking Preview as apply mode makes body.applyMode preview", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [], models: [MODEL_A1, MODEL_B1], actions: [ACTION_CUSTOM] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === "/api/admin/ai/actions" && method === "POST") {
        return Promise.resolve(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ ...ACTION_CUSTOM, id: "a-new" }) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(ACTION_CUSTOM.name)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));
    const dialog = await screen.findByRole("dialog", { name: "Add action" });
    const modelTrigger = within(dialog).getByLabelText("Model");
    const applyTrigger = within(dialog).getByLabelText("Apply mode");

    expect(selectedValue(modelTrigger)).toBe("");
    expect(displayedLabel(modelTrigger)).toBe("Auto (prefers the default model)");
    expect(selectedValue(applyTrigger)).toBe("direct");
    expect(await optionLabels(modelTrigger)).toEqual(["Auto (prefers the default model)", "Claude Sonnet", "Llama 3"]);

    await chooseOption(modelTrigger, "Llama 3");
    expect(displayedLabel(modelTrigger)).toBe("Llama 3");
    await chooseOption(applyTrigger, "Preview");
    expect(selectedValue(applyTrigger)).toBe("preview");

    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "New action" } });
    fireEvent.change(within(dialog).getByLabelText("System prompt"), { target: { value: "You are helpful." } });
    fireEvent.change(within(dialog).getByLabelText("User template"), { target: { value: "Do something with:\n{{text}}" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([reqUrl, reqInit]) => String(reqUrl) === "/api/admin/ai/actions" && (reqInit as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String((call as [RequestInfo, RequestInit])[1].body)) as Record<string, unknown>;
      expect(body.modelId).toBe(MODEL_B1.id);
      expect(body.applyMode).toBe("preview");
    });
  });

  it("editing an action: choosing Auto again submits modelId null", async () => {
    const withModel: AdminAiActionDto = { ...ACTION_CUSTOM, modelId: MODEL_A1.id };
    let patchBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [], models: [MODEL_A1], actions: [withModel] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === `/api/admin/ai/actions/${withModel.id}` && method === "PATCH") {
        patchBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(withModel) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(withModel.name)).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("row", { name: withModel.name })).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit action" });
    const modelTrigger = within(dialog).getByLabelText("Model");
    expect(displayedLabel(modelTrigger)).toBe("Claude Sonnet");
    await chooseOption(modelTrigger, "Auto (prefers the default model)");
    expect(selectedValue(modelTrigger)).toBe("");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patchBody).toBeDefined());
    expect(patchBody?.modelId).toBeNull();
  });

  it("editing an action: when the model list arrives late, the stored model isn't reset to Auto and the submit still carries the original model id", async () => {
    const withModel: AdminAiActionDto = { ...ACTION_CUSTOM, modelId: MODEL_A1.id };
    let releaseModels: () => void = () => {};
    const modelsGate = new Promise<void>((resolve) => {
      releaseModels = resolve;
    });
    let patchBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/admin/ai/models" && method === "GET") {
        return modelsGate.then(() => fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ models: [MODEL_A1] }) }));
      }
      const res = defaultGetHandlers({ providers: [], models: [MODEL_A1], actions: [withModel] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === `/api/admin/ai/actions/${withModel.id}` && method === "PATCH") {
        patchBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(withModel) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(withModel.name)).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("row", { name: withModel.name })).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit action" });
    const modelTrigger = within(dialog).getByLabelText("Model");

    releaseModels();
    await waitFor(() => expect(displayedLabel(modelTrigger)).toBe("Claude Sonnet"));
    expect(selectedValue(modelTrigger)).toBe(MODEL_A1.id);

    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patchBody).toBeDefined());
    expect(patchBody?.modelId).toBe(MODEL_A1.id);
  });

  it("adding and editing a provider: the type dropdown offers OpenAI-compatible, the submitted type is openai_compatible", async () => {
    let postBody: Record<string, unknown> | undefined;
    let patchBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [PROVIDER_A], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === "/api/admin/ai/providers" && method === "POST") {
        postBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Promise.resolve(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ ...PROVIDER_A, id: "p-new" }) }));
      }
      if (url === `/api/admin/ai/providers/${PROVIDER_A.id}` && method === "PATCH") {
        patchBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(PROVIDER_A) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(PROVIDER_A.name)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    const addDialog = await screen.findByRole("dialog", { name: "Add provider" });
    await chooseOption(within(addDialog).getByLabelText("Type"), "OpenAI-compatible");
    fireEvent.change(within(addDialog).getByLabelText("Name"), { target: { value: "Local" } });
    fireEvent.change(within(addDialog).getByLabelText("Base URL"), { target: { value: "http://host.example.com/v1" } });
    fireEvent.click(within(addDialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(postBody).toBeDefined());
    expect(postBody?.type).toBe("openai_compatible");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add provider" })).toBeNull());

    fireEvent.click(within(screen.getByRole("row", { name: PROVIDER_A.name })).getByRole("button", { name: "Edit" }));
    const editDialog = await screen.findByRole("dialog", { name: "Edit provider" });
    const editType = within(editDialog).getByLabelText("Type");
    expect(displayedLabel(editType)).toBe("Anthropic");
    await chooseOption(editType, "OpenAI-compatible");
    fireEvent.click(within(editDialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patchBody).toBeDefined());
    expect(patchBody?.type).toBe("openai_compatible");
  });

  it("up/down buttons: PATCH swaps sortOrder", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [], models: [], actions: [ACTION_BUILTIN, ACTION_CUSTOM] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === `/api/admin/ai/actions/${ACTION_BUILTIN.id}` && method === "PATCH") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ACTION_BUILTIN) }));
      }
      if (url === `/api/admin/ai/actions/${ACTION_CUSTOM.id}` && method === "PATCH") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ACTION_CUSTOM) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(ACTION_CUSTOM.name)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: `Move up ${ACTION_CUSTOM.name}` }));

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(([, reqInit]) => (reqInit as RequestInit | undefined)?.method === "PATCH");
      expect(patchCalls).toHaveLength(2);
    });

    const patchCalls = fetchMock.mock.calls.filter(([, reqInit]) => (reqInit as RequestInit | undefined)?.method === "PATCH");
    const [firstUrl, firstInit] = patchCalls[0] as [RequestInfo, RequestInit];
    const [secondUrl, secondInit] = patchCalls[1] as [RequestInfo, RequestInit];
    expect(String(firstUrl)).toBe(`/api/admin/ai/actions/${ACTION_CUSTOM.id}`);
    expect(JSON.parse(String(firstInit.body))).toEqual({ sortOrder: ACTION_BUILTIN.sortOrder });
    expect(String(secondUrl)).toBe(`/api/admin/ai/actions/${ACTION_BUILTIN.id}`);
    expect(JSON.parse(String(secondInit.body))).toEqual({ sortOrder: ACTION_CUSTOM.sortOrder });
  });

  it("up/down buttons: clicking repeatedly while a mutation is in flight is a no-op, no second PATCH set is sent (regression)", async () => {
    // Without an in-flight lock (only `!canMoveUp/Down`), rapid clicks would each send a second "swap with neighbor" PATCH set from the same stale
    // `actions` array; the two swaps cancel out and leave two rows with the same `sortOrder` (the Edit form doesn't send that field, so it can't be repaired). Here the first PATCH
    // is held unresolved to simulate "the user clicked again before the button became disabled", and the assertion is that only the original set (2 PATCHes) is ever sent.
    let resolveFirstPatch!: (value: Response) => void;
    const firstPatchPromise = new Promise<Response>((resolve) => {
      resolveFirstPatch = resolve;
    });

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [], models: [], actions: [ACTION_BUILTIN, ACTION_CUSTOM] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === `/api/admin/ai/actions/${ACTION_CUSTOM.id}` && method === "PATCH") {
        return firstPatchPromise;
      }
      if (url === `/api/admin/ai/actions/${ACTION_BUILTIN.id}` && method === "PATCH") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ACTION_BUILTIN) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderSection(fetchMock);

    await waitFor(() => expect(screen.getByText(ACTION_CUSTOM.name)).toBeInTheDocument());
    const moveUpButton = screen.getByRole("button", { name: `Move up ${ACTION_CUSTOM.name}` });

    fireEvent.click(moveUpButton);
    await waitFor(() => expect(moveUpButton).toBeDisabled());

    // The first PATCH is still unresolved: the button should already be disabled, so this click must be a no-op.
    fireEvent.click(moveUpButton);

    resolveFirstPatch(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ACTION_CUSTOM) }));

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(([, reqInit]) => (reqInit as RequestInit | undefined)?.method === "PATCH");
      expect(patchCalls).toHaveLength(2);
    });

    // Give the second (neighbor) PATCH one round of microtasks to send and the mutateAsync chain to settle,
    // so the total really is 2 and not undercounted because the assertion ran too early.
    await waitFor(() => expect(moveUpButton).not.toBeDisabled());
    const patchCalls = fetchMock.mock.calls.filter(([, reqInit]) => (reqInit as RequestInit | undefined)?.method === "PATCH");
    expect(patchCalls).toHaveLength(2);
  });

  it("any mutation success -> invalidates the ['admin-ai'] prefix and ['ai-actions']", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [PROVIDER_A], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      if (url === `/api/admin/ai/providers/${PROVIDER_A.id}` && method === "PATCH") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ ...PROVIDER_A, enabled: false }) }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    renderSection(fetchMock, queryClient);

    await waitFor(() => expect(screen.getByText(PROVIDER_A.name)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("switch", { name: `Enabled ${PROVIDER_A.name}` }));

    await waitFor(() => {
      const keys = invalidateSpy.mock.calls.map(([arg]) => (arg as { queryKey: unknown[] }).queryKey);
      expect(keys).toContainEqual(["admin-ai"]);
      expect(keys).toContainEqual(["ai-actions"]);
    });
  });
});

describe("AI settings tables (#3)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubDefault() {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers()(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
  }

  /** Takes only this table's own header (the model sub-table's sr-only header is also inside the provider table's subtree). */
  const ownHeaders = (table: HTMLElement) =>
    within(table)
      .getAllByRole("columnheader")
      .filter((cell) => cell.closest('[role="table"]') === table)
      .map((cell) => cell.textContent);
  const buttonNames = (scope: HTMLElement) => within(scope).getAllByRole("button").map((button) => button.getAttribute("aria-label"));

  it("provider table: table name Providers, column names Name / Type / Base URL / Models / Actions / Enabled; row name = provider name, the row has type, Base URL, model names, Test connection / Edit / Delete (in order) and the \"Enabled <name>\" switch", async () => {
    renderSection(stubDefault());
    const table = await screen.findByRole("table", { name: "Providers" });
    expect(ownHeaders(table)).toEqual(["Name", "Type", "Base URL", "Models", "Actions", "Enabled"]);
    const row = within(table).getByRole("row", { name: PROVIDER_A.name });
    expect(within(row).getByRole("cell", { name: "Anthropic" })).toBeInTheDocument();
    expect(within(row).getByRole("cell", { name: PROVIDER_A.baseUrl })).toBeInTheDocument();
    expect(within(row).getByRole("cell", { name: MODEL_A1.displayName })).toBeInTheDocument();
    expect(buttonNames(row)).toEqual(["Test connection", "Edit", "Delete"]);
    expect(within(row).getByRole("switch", { name: `Enabled ${PROVIDER_A.name}` })).toBeInTheDocument();
  });

  it("column widths: provider table name column 1, Base URL 1.5, Models 1 (real mount)", async () => {
    renderSection(stubDefault());
    const table = await screen.findByRole("table", { name: "Providers" });
    expect(table.style.getPropertyValue("--kb-table-cols")).toBe("minmax(14ch,1fr) max-content minmax(14ch,1.5fr) minmax(14ch,1fr) 6.5rem 3.5rem");
  });

  it("provider detail row: right after the data row, named \"<name> details\", containing the key note and the model sub-table \"Models - <name>\" (nested: no scroll box of its own; title Models + Add model; sub-table row name = model name, subtitle modelId, Edit / Delete, switch \"Enabled <model name>\")", async () => {
    renderSection(stubDefault());
    const dataRow = await screen.findByRole("row", { name: PROVIDER_B.name });
    const details = screen.getByRole("row", { name: `${PROVIDER_B.name} details` });
    expect(dataRow.nextElementSibling).toBe(details);
    expect(within(details).getByText(/No API key stored/)).toBeInTheDocument();
    const models = within(details).getByRole("table", { name: `Models – ${PROVIDER_B.name}` });
    expect(screen.queryByRole("region", { name: `Models – ${PROVIDER_B.name}` })).toBeNull();
    expect(within(details).getByText("Models")).toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "Add model" })).toBeInTheDocument();
    const modelRow = within(models).getByRole("row", { name: MODEL_B1.displayName });
    expect(within(modelRow).getByText(MODEL_B1.modelId)).toBeInTheDocument();
    expect(buttonNames(modelRow)).toEqual(["Edit", "Delete"]);
    expect(within(modelRow).getByRole("switch", { name: `Enabled ${MODEL_B1.displayName}` })).toBeInTheDocument();
  });

  it("the in-page \"Add provider\", \"Add model\", \"Add action\" buttons are not solid buttons", async () => {
    renderSection(stubDefault());
    await screen.findByText(ACTION_CUSTOM.name);
    for (const name of ["Add provider", "Add action"]) {
      expect(screen.getByRole("button", { name }).className).not.toMatch(/(^|\s)bg-(primary|brand|brand-deep)(\s|$)/);
    }
    for (const button of screen.getAllByRole("button", { name: "Add model" })) {
      expect(button.className).not.toMatch(/(^|\s)bg-(primary|brand|brand-deep)(\s|$)/);
    }
  });

  it("action table: group title and table name are both Actions; column names Name / Apply mode / Model / Actions / Enabled; built-in rows have a Built-in label and no Delete; button order is move up, move down, edit, delete; switch name \"Enabled <action name>\" (exception)", async () => {
    renderSection(stubDefault());
    const table = await screen.findByRole("table", { name: "Actions" });
    expect(screen.getByRole("heading", { level: 2, name: "Actions" })).toBeInTheDocument();
    expect(ownHeaders(table)).toEqual(["Name", "Apply mode", "Model", "Actions", "Enabled"]);
    const builtin = within(table).getByRole("row", { name: ACTION_BUILTIN.name });
    expect(within(builtin).getByText("Built-in")).toBeInTheDocument();
    expect(buttonNames(builtin)).toEqual([`Move up ${ACTION_BUILTIN.name}`, `Move down ${ACTION_BUILTIN.name}`, "Edit"]);
    const custom = within(table).getByRole("row", { name: ACTION_CUSTOM.name });
    expect(buttonNames(custom)).toEqual([`Move up ${ACTION_CUSTOM.name}`, `Move down ${ACTION_CUSTOM.name}`, "Edit", "Delete"]);
    expect(within(custom).getByRole("cell", { name: "Preview" })).toBeInTheDocument();
    expect(within(custom).getByRole("cell", { name: "Auto (prefers the default model)" })).toBeInTheDocument();
    expect(within(custom).getByRole("switch", { name: `Enabled ${ACTION_CUSTOM.name}` })).toBeInTheDocument();
  });

  it("move up / move down are natively disabled at the list boundaries (first row can't move up, last can't move down; temporary disabling)", async () => {
    renderSection(stubDefault());
    await screen.findByRole("table", { name: "Actions" });
    expect(screen.getByRole("button", { name: `Move up ${ACTION_BUILTIN.name}` })).toBeDisabled();
    expect(screen.getByRole("button", { name: `Move down ${ACTION_CUSTOM.name}` })).toBeDisabled();
    expect(screen.getByRole("button", { name: `Move down ${ACTION_BUILTIN.name}` })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: `Move up ${ACTION_CUSTOM.name}` })).not.toBeDisabled();
  });

  it("the model and action switches (new name \"Enabled <name>\") still send PATCH {enabled}", async () => {
    const patches: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers()(url, method);
      if (res) return Promise.resolve(res);
      if (method === "PATCH" && url === `/api/admin/ai/models/${MODEL_A1.id}`) {
        patches.push({ url, body: JSON.parse(String(init?.body)) });
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ ...MODEL_A1, enabled: false }) }));
      }
      if (method === "PATCH" && url === `/api/admin/ai/actions/${ACTION_CUSTOM.id}`) {
        patches.push({ url, body: JSON.parse(String(init?.body)) });
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ ...ACTION_CUSTOM, enabled: false }) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    renderSection(fetchMock);
    fireEvent.click(await screen.findByRole("switch", { name: `Enabled ${MODEL_A1.displayName}` }));
    fireEvent.click(screen.getByRole("switch", { name: `Enabled ${ACTION_CUSTOM.name}` }));
    await waitFor(() =>
      expect(patches).toEqual([
        { url: `/api/admin/ai/models/${MODEL_A1.id}`, body: { enabled: false } },
        { url: `/api/admin/ai/actions/${ACTION_CUSTOM.id}`, body: { enabled: false } },
      ]),
    );
  });

  it("test connection in-progress state and result appear only in the tested provider's detail row (the root component keeps them keyed by provider id)", async () => {
    const FAIL = "AI provider is unavailable — ask an admin to re-enter the API key";
    let resolveB: (res: Response) => void = () => {};
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = defaultGetHandlers({ providers: [PROVIDER_A, PROVIDER_B], models: [], actions: [] })(url, method);
      if (res) return Promise.resolve(res);
      if (method === "POST" && url === `/api/admin/ai/providers/${PROVIDER_B.id}/test`) {
        // Hold first, so we can see which row "Testing..." lands on.
        return new Promise<Response>((resolve) => {
          resolveB = resolve;
        });
      }
      if (method === "POST" && url === `/api/admin/ai/providers/${PROVIDER_A.id}/test`) {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    renderSection(fetchMock);
    const details = (provider: AdminAiProviderDto) => screen.getByRole("row", { name: `${provider.name} details` });
    await screen.findByRole("row", { name: `${PROVIDER_B.name} details` });

    fireEvent.click(within(screen.getByRole("row", { name: PROVIDER_B.name })).getByRole("button", { name: "Test connection" }));
    expect(await within(details(PROVIDER_B)).findByText("Testing…")).toHaveAttribute("role", "status");
    expect(within(details(PROVIDER_A)).queryByText("Testing…")).toBeNull();

    resolveB(
      fakeResponse({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: { code: "provider_unavailable", message: "此 provider 目前無法使用" } }),
      }),
    );
    await waitFor(() => expect(within(details(PROVIDER_B)).getByRole("alert")).toHaveTextContent(FAIL));
    expect(within(details(PROVIDER_B)).queryByText("Testing…")).toBeNull();
    expect(within(details(PROVIDER_A)).queryByText(FAIL)).toBeNull();

    // Success path: A's result sits only on A, B's failure result isn't overwritten.
    fireEvent.click(within(screen.getByRole("row", { name: PROVIDER_A.name })).getByRole("button", { name: "Test connection" }));
    expect(await within(details(PROVIDER_A)).findByText("Connection succeeded.")).toHaveAttribute("role", "status");
    expect(within(details(PROVIDER_B)).queryByText("Connection succeeded.")).toBeNull();
    expect(within(details(PROVIDER_B)).getByRole("alert")).toHaveTextContent(FAIL);
  });
});
