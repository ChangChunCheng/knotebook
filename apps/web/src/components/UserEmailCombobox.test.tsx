import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { UserSuggestionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { UserEmailCombobox } from "./UserEmailCombobox";

const ANN: UserSuggestionDto = { userId: "u-ann", email: "ann@example.com", displayName: "Ann Example" };
const ANDY: UserSuggestionDto = { userId: "u-andy", email: "andy@example.com", displayName: "Andy Example" };

function suggestFetch(users: UserSuggestionDto[] = [ANN, ANDY]) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/users/suggest?")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ users }) } as unknown as Response);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function Harness({ onSubmit, exclude, inDialog = false }: { onSubmit: (email: string) => void; exclude?: string[]; inDialog?: boolean }) {
  const [value, setValue] = useState("");
  const form = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value);
      }}
    >
      <UserEmailCombobox label="Email address" value={value} onChange={setValue} excludeUserIds={exclude} />
      <button type="submit">Add</button>
    </form>
  );
  if (!inDialog) return form;
  return (
    <Dialog open onOpenChange={() => onSubmit("__dialog_closed__")}>
      <DialogContent>
        <DialogTitle>Dialog</DialogTitle>
        <DialogDescription>desc</DialogDescription>
        {form}
      </DialogContent>
    </Dialog>
  );
}

function renderHarness(props: Parameters<typeof Harness>[0]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
}

function input(): HTMLInputElement {
  return screen.getByRole("combobox", { name: "Email address" }) as HTMLInputElement;
}

async function typeAndWaitForList(text: string): Promise<HTMLElement> {
  fireEvent.change(input(), { target: { value: text } });
  return screen.findByRole("listbox", { name: "People you know" });
}

describe("UserEmailCombobox", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("≥ 2 字、debounce 之後才查；清單列顯示名稱＋email；ARIA 狀態", async () => {
    const fetchMock = suggestFetch();
    renderHarness({ onSubmit: vi.fn() });
    expect(input()).toHaveAttribute("aria-expanded", "false");

    fireEvent.change(input(), { target: { value: "a" } });
    await new Promise((r) => setTimeout(r, 300));
    expect(fetchMock).not.toHaveBeenCalled();

    const list = await typeAndWaitForList("an");
    expect(fetchMock).toHaveBeenCalledWith("/api/users/suggest?q=an", expect.anything());
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Ann Exampleann@example.com", "Andy Exampleandy@example.com"]);
    expect(input()).toHaveAttribute("aria-expanded", "true");
    expect(input()).toHaveAttribute("aria-controls", list.id);
    expect(input()).not.toHaveAttribute("aria-activedescendant");
  });

  it("鍵盤：↓／↑ 移動（循環）、Enter 選取填入 email 且不送出表單", async () => {
    suggestFetch();
    const onSubmit = vi.fn();
    renderHarness({ onSubmit });
    const list = await typeAndWaitForList("an");
    const [first, second] = within(list).getAllByRole("option");

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input()).toHaveAttribute("aria-activedescendant", first!.id);
    expect(first).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input()).toHaveAttribute("aria-activedescendant", second!.id);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input()).toHaveAttribute("aria-activedescendant", first!.id);
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(input()).toHaveAttribute("aria-activedescendant", second!.id);

    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input()).toHaveValue("andy@example.com");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(onSubmit).not.toHaveBeenCalled();

    // 選完再按 Enter（沒有選中項目）→ 照常送出表單
    fireEvent.submit(input().form!);
    expect(onSubmit).toHaveBeenCalledWith("andy@example.com");
  });

  it("點選項目填入 email", async () => {
    suggestFetch();
    renderHarness({ onSubmit: vi.fn() });
    const list = await typeAndWaitForList("an");
    const option = within(list).getByRole("option", { name: /Ann Example/ });
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(input()).toHaveValue("ann@example.com");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("沒有選中項目時 Enter 不攔：打的完整 email 照樣送出", async () => {
    suggestFetch([]);
    const onSubmit = vi.fn();
    renderHarness({ onSubmit });
    fireEvent.change(input(), { target: { value: "someone@example.com" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.submit(input().form!);
    expect(onSubmit).toHaveBeenCalledWith("someone@example.com");
  });

  it("Esc 收起清單，但不關掉外層 Dialog", async () => {
    suggestFetch();
    const onSubmit = vi.fn();
    renderHarness({ onSubmit, inDialog: true });
    await typeAndWaitForList("an");
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    // 清單已收起時 Esc 照常交給 Dialog
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onSubmit).toHaveBeenCalledWith("__dialog_closed__");
  });

  it("excludeUserIds 裡的人不出現", async () => {
    suggestFetch();
    renderHarness({ onSubmit: vi.fn(), exclude: [ANN.userId] });
    const list = await typeAndWaitForList("an");
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["Andy Exampleandy@example.com"]);
  });

  it("查詢失敗 → 沒有清單，輸入框照常可用", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({ error: { code: "too_many_requests", message: "x" } }) } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);
    renderHarness({ onSubmit: vi.fn() });
    fireEvent.change(input(), { target: { value: "an" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input()).toHaveValue("an");
  });
});
