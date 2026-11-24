import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import "@/i18n/knowledge-strings";
import { MemberPicker } from "./MemberPicker";

const NOTE = "11111111-2222-3333-4444-555555555555";
const ME: UserDto = { id: "aaaaaaaa-0000-4000-8000-000000000000", email: "carol@example.com", handle: "carol", displayName: "Carol", isAdmin: false, mustChangePassword: false } as UserDto;
const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "aaaaaaaa-0000-4000-8000-000000000002";
const GONE = "aaaaaaaa-0000-4000-8000-000000000009";

const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);
let suggestQueries: string[];

beforeEach(async () => {
  await i18n.changeLanguage("en");
  suggestQueries = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/me") return json(ME);
      if (url.startsWith("/api/users/suggest?q=")) {
        suggestQueries.push(decodeURIComponent(url.slice("/api/users/suggest?q=".length)));
        return json({ users: [{ userId: ALICE, email: "alice@example.com", displayName: "Alice Liddell", avatar: null }] });
      }
      if (url === "/api/knowledge/members") {
        const ids = (JSON.parse(String(init?.body)) as { ids?: string[] }).ids ?? [];
        return json({ byId: ids.filter((id) => id === BOB).map((id) => ({ id, handle: "bob", displayName: "Bob Stored" })), byToken: [] });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function Host({ initial, onChange }: { initial: string; onChange: (id: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <span id="owner-label">Owner</span>
      <MemberPicker
        id="owner"
        labelledBy="owner-label"
        value={value}
        noteId={NOTE}
        onChange={(id) => {
          setValue(id);
          onChange(id);
        }}
      />
    </>
  );
}

function renderPicker(initial = "") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_QUERY_KEY, ME);
  const onChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <Host initial={initial} onChange={onChange} />
    </QueryClientProvider>,
  );
  return { onChange, input: screen.getByRole("combobox", { name: "Owner" }) as HTMLInputElement };
}

const options = () => within(screen.getByRole("listbox")).queryAllByRole("option").map((o) => o.textContent);

describe("MemberPicker", () => {
  it("the member picker offers me first and suggestions after two characters", async () => {
    const { input, onChange } = renderPicker();
    fireEvent.focus(input);
    expect(options()).toEqual(["Me"]);
    fireEvent.change(input, { target: { value: "a" } });
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(suggestQueries).toEqual([]);
    expect(options()).toEqual(["Me"]);
    fireEvent.change(input, { target: { value: "al" } });
    await waitFor(() => expect(options()).toEqual(["Me", "Alice Liddellalice@example.com"]));
    expect(suggestQueries).toEqual(["al"]);
    fireEvent.mouseDown(screen.getByRole("option", { name: /Alice Liddell/ }));
    expect(onChange).toHaveBeenLastCalledWith(ALICE);
    expect(input.value).toBe("Alice Liddell");
  });

  it("picking Me stores my id, and the clear button empties the value", () => {
    const { input, onChange } = renderPicker();
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByRole("option", { name: "Me" }));
    expect(onChange).toHaveBeenLastCalledWith(ME.id);
    expect(input.value).toBe("Carol");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(input.value).toBe("");
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("a stored member that isn't among the suggestions still shows its name", async () => {
    const { input } = renderPicker(BOB);
    await waitFor(() => expect(input.value).toBe("Bob Stored"));
  });

  it("a member not found shows Unknown member", async () => {
    const { input } = renderPicker(GONE);
    await waitFor(() => expect(input.value).toBe("Unknown member"));
  });

  it("Enter picks the highlighted row and is consumed", () => {
    const { input, onChange } = renderPicker();
    fireEvent.focus(input);
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(ME.id);
  });
});
