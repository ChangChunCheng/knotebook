import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_KNOWLEDGE_FIELD_VIEW, type AdminKnowledgeFieldsDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { SettingsKnowledgeFieldsSection } from "./SettingsKnowledgeFieldsSection";

const URL_ = "/api/admin/knowledge-fields";
const DTO: AdminKnowledgeFieldsDto = {
  fields: DEFAULT_KNOWLEDGE_FIELD_VIEW.fields.map((f) => ({ ...f })),
  limits: { customEnabledMax: 20, customTotalMax: 100, optionsMax: 30, nameMax: 60 },
};

function res(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

type PutBody = { fields: Array<Record<string, unknown>> };

function setup(put?: (body: PutBody) => Response, data: AdminKnowledgeFieldsDto = DTO) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === URL_ && method === "GET") return Promise.resolve(res(200, data));
    if (url === URL_ && method === "PUT") return Promise.resolve((put ?? (() => res(200, data)))(JSON.parse(String(init?.body)) as PutBody));
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SettingsKnowledgeFieldsSection />
      <Toaster />
    </QueryClientProvider>,
  );
  const puts = () => fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "PUT").map(([, i]) => JSON.parse(String((i as RequestInit).body)) as PutBody);
  return { puts };
}

const loaded = () => screen.findByRole("switch", { name: "Show When to read" });
const save = () => screen.getByRole("button", { name: "Save" });

describe("SettingsKnowledgeFieldsSection", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    dismissAllToasts();
    vi.unstubAllGlobals();
  });

  it("lists the status as a locked row and the five built-in fields", async () => {
    setup();
    await loaded();
    expect(screen.getByRole("switch", { name: "Show Status" })).toBeDisabled();
    for (const n of ["When to read", "Conclusion", "Basis", "Last verified", "Replaced by"]) {
      expect(screen.getByRole("switch", { name: `Show ${n}` })).toBeChecked();
    }
    expect(screen.getByText("Single choice")).toBeInTheDocument();
  });

  it("Save is disabled without changes and enabled after one", async () => {
    setup();
    const toggle = await loaded();
    expect(save()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeDisabled();
    fireEvent.click(toggle);
    expect(save()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeEnabled();
  });

  it("turning off When to read and saving sends enabled false", async () => {
    const { puts } = setup();
    fireEvent.click(await loaded());
    fireEvent.click(save());
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.fields[0]).toEqual({ key: "when", enabled: false });
    await screen.findByText("Saved.");
  });

  it("a new option's key follows its name, and is read-only once saved", async () => {
    const saved: AdminKnowledgeFieldsDto = {
      ...DTO,
      fields: DTO.fields.map((f) =>
        f.key === "evidence" ? { ...f, options: [...f.options!, { key: "vendor-docs", name: "Vendor docs", enabled: true, builtin: false }] } : f,
      ),
    };
    const { puts } = setup(() => res(200, saved));
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    fireEvent.change(screen.getAllByLabelText("Option name").at(-1)!, { target: { value: "Vendor docs" } });
    expect(screen.getAllByLabelText("Key").at(-1)).toHaveValue("vendor-docs");
    expect(screen.getAllByLabelText("Key").at(-1)).not.toHaveAttribute("readonly");
    fireEvent.click(save());
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.fields[2]!.options).toEqual([
      { key: "tested", name: null, enabled: true },
      { key: "docs", name: null, enabled: true },
      { key: "inferred", name: null, enabled: true },
      { key: "vendor-docs", name: "Vendor docs", enabled: true },
    ]);
    await waitFor(() => expect(screen.getAllByLabelText("Key").at(-1)).toHaveAttribute("readonly"));
  });

  it("a key-taken error shows under the option and keeps the draft", async () => {
    const { puts } = setup(() => res(400, { error: { code: "knowledge_key_taken", message: "x" } }));
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    fireEvent.change(screen.getAllByLabelText("Option name").at(-1)!, { target: { value: "Vendor" } });
    fireEvent.change(screen.getAllByLabelText("Key").at(-1)!, { target: { value: "docs" } });
    fireEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("Two options have the same key.");
    expect(puts()).toHaveLength(1);
    expect(screen.getAllByLabelText("Key").at(-1)).toHaveValue("docs");
    expect(save()).toBeEnabled();
  });

  it("a key-invalid error shows under the option", async () => {
    setup(() => res(400, { error: { code: "knowledge_key_invalid", message: "x" } }));
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    fireEvent.change(screen.getAllByLabelText("Option name").at(-1)!, { target: { value: "Vendor" } });
    fireEvent.change(screen.getAllByLabelText("Key").at(-1)!, { target: { value: "-Bad Key" } });
    fireEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("That option key is not valid.");
  });

  it("a key error the draft cannot explain falls back to a toast", async () => {
    setup(() => res(400, { error: { code: "knowledge_key_taken", message: "x" } }));
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    fireEvent.change(screen.getAllByLabelText("Option name").at(-1)!, { target: { value: "Vendor" } });
    fireEvent.click(save());
    expect(await screen.findByText("Two options have the same key.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("blocks Save when a new option has no name", async () => {
    const { puts } = setup();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    fireEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a name");
    expect(puts()).toHaveLength(0);
  });

  it("blocks Save when a saved custom option has its name cleared", async () => {
    const withCustom: AdminKnowledgeFieldsDto = {
      ...DTO,
      fields: DTO.fields.map((f) =>
        f.key === "evidence" ? { ...f, options: [...f.options!, { key: "vendor-docs", name: "Vendor docs", enabled: true, builtin: false }] } : f,
      ),
    };
    const { puts } = setup(undefined, withCustom);
    await loaded();
    fireEvent.change(screen.getAllByLabelText("Option name").at(-1)!, { target: { value: "" } });
    fireEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a name");
    expect(puts()).toHaveLength(0);
  });

  it("caps an option name at 60 characters", async () => {
    setup();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    const input = screen.getAllByLabelText("Option name").at(-1)!;
    fireEvent.change(input, { target: { value: "字".repeat(70) } });
    expect([...(input as HTMLInputElement).value]).toHaveLength(60);
  });

  it("after an incomplete-settings error the editor is rebuilt from fresh data", async () => {
    let puts = 0;
    const fresh: AdminKnowledgeFieldsDto = {
      ...DTO,
      fields: DTO.fields.map((f) => (f.key === "when" ? { ...f, enabled: false } : f)),
    };
    let current = DTO;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT") {
        puts += 1;
        current = fresh;
        return Promise.resolve(res(400, { error: { code: "knowledge_fields_incomplete", message: "x" } }));
      }
      expect(String(input)).toBe(URL_);
      return Promise.resolve(res(200, current));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SettingsKnowledgeFieldsSection />
        <Toaster />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("switch", { name: "Show Conclusion" }));
    fireEvent.click(save());
    await waitFor(() => expect(puts).toBe(1));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Show When to read" })).not.toBeChecked());
    expect(screen.getByRole("switch", { name: "Show Conclusion" })).toBeChecked();
    expect(screen.getByText(/Someone else changed these settings/)).toBeInTheDocument();
  });

  it("keeps the inputs disabled during the refetch, and keeps the draft when the refetch fails", async () => {
    let gets = 0;
    let release: (() => void) | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT") return Promise.resolve(res(400, { error: { code: "knowledge_fields_incomplete", message: "x" } }));
      gets += 1;
      if (gets === 1) return Promise.resolve(res(200, DTO));
      return new Promise<Response>((resolve) => {
        release = () => resolve(res(500, { error: { code: "internal", message: "x" } }));
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SettingsKnowledgeFieldsSection />
        <Toaster />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("switch", { name: "Show Conclusion" }));
    fireEvent.click(save());
    await waitFor(() => expect(release).toBeDefined());
    expect(screen.getByRole("switch", { name: "Show Conclusion" })).toBeDisabled();
    release!();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Show Conclusion" })).toBeEnabled());
    expect(screen.getByRole("switch", { name: "Show Conclusion" })).not.toBeChecked();
    expect(screen.queryByText(/Someone else changed these settings/)).not.toBeInTheDocument();
  });

  it("outlines the name input for a missing name and the key input only for key errors", async () => {
    setup();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    fireEvent.click(save());
    await screen.findByRole("alert");
    expect(screen.getAllByLabelText("Option name").at(-1)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByLabelText("Key").at(-1)).not.toHaveAttribute("aria-invalid");
    fireEvent.change(screen.getAllByLabelText("Option name").at(-1)!, { target: { value: "Vendor" } });
    fireEvent.change(screen.getAllByLabelText("Key").at(-1)!, { target: { value: "" } });
    fireEvent.click(save());
    await screen.findByRole("alert");
    expect(screen.getAllByLabelText("Key").at(-1)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByLabelText("Option name").at(-1)).not.toHaveAttribute("aria-invalid");
  });

  it("moves the row that was clicked even when a new row repeats an existing key", async () => {
    const { puts } = setup(() => res(400, { error: { code: "knowledge_key_taken", message: "x" } }));
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    fireEvent.change(screen.getAllByLabelText("Option name").at(-1)!, { target: { value: "Vendor" } });
    fireEvent.change(screen.getAllByLabelText("Key").at(-1)!, { target: { value: "docs" } });
    const rows = screen.getAllByRole("listitem");
    fireEvent.click(within(rows[3]!).getByRole("button", { name: "Move up" }));
    fireEvent.click(save());
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect((puts()[0]!.fields[2]!.options as Array<{ key: string }>).map((o) => o.key)).toEqual(["tested", "docs", "docs", "inferred"]);
    expect((puts()[0]!.fields[2]!.options as Array<{ name: string | null }>)[2]!.name).toBe("Vendor");
  });

  it("other server errors show in a toast", async () => {
    setup(() => res(400, { error: { code: "knowledge_fields_limit", message: "x" } }));
    fireEvent.click(await loaded());
    fireEvent.click(save());
    expect(await screen.findByText("A field can have at most 30 options.")).toBeInTheDocument();
  });

  it("blocks Save with a message when a new option has no key", async () => {
    const { puts } = setup();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    fireEvent.change(screen.getAllByLabelText("Option name").at(-1)!, { target: { value: "Vendor" } });
    fireEvent.change(screen.getAllByLabelText("Key").at(-1)!, { target: { value: "" } });
    fireEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a key");
    expect(puts()).toHaveLength(0);
  });

  it("moves an option up and sends the new order", async () => {
    const { puts } = setup();
    await loaded();
    const rows = screen.getAllByRole("listitem");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Move up" }));
    fireEvent.click(save());
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect((puts()[0]!.fields[2]!.options as Array<{ key: string }>).map((o) => o.key)).toEqual(["docs", "tested", "inferred"]);
  });

  it("disables Add option at 30 options and says why", async () => {
    const options = Array.from({ length: 30 }, (_, i) => ({ key: `o${i}`, name: `Option ${i}`, enabled: true, builtin: false }));
    setup(undefined, { ...DTO, fields: DTO.fields.map((f) => (f.key === "evidence" ? { ...f, options } : f)) });
    await loaded();
    expect(screen.getByRole("button", { name: "Add option" })).toBeDisabled();
    expect(screen.getByText("At most 30 options.")).toBeInTheDocument();
  });

  it("Discard changes restores the saved state", async () => {
    setup();
    fireEvent.click(await loaded());
    expect(screen.getByRole("switch", { name: "Show When to read" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("switch", { name: "Show When to read" })).toBeChecked();
  });
});
