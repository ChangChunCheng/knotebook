import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { SetPasswordForm } from "@/settings/SetPasswordForm";

function wrap(node: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
}

const PASSWORD_FIELD_IDS = ["change-password-current", "change-password-new", "change-password-confirm"];

describe("password form's submit button inside a panel (#247)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it('ChangePasswordForm tone="outline" -> submit button is outline, not solid, not full width', () => {
    const { container } = wrap(<ChangePasswordForm tone="outline" onSuccess={() => {}} />);
    const submit = screen.getByRole("button", { name: "Change password" });
    expect(submit).toHaveClass("border-input");
    expect(submit).not.toHaveClass("bg-brand-deep");
    expect(submit).not.toHaveClass("bg-brand");
    expect(submit).not.toHaveClass("w-full");
    // Stays 32px inside the settings modal (only tone="page" is enlarged, see ui/button.tsx)
    expect(submit).toHaveClass("h-8");
    expect(submit).not.toHaveClass("h-11");
    for (const id of PASSWORD_FIELD_IDS) {
      expect(container.querySelector(`#${id}`)).not.toHaveClass("h-11");
    }
  });

  it('ChangePasswordForm default tone ("page", the full /change-password page) -> brandSolid full width, behaviour unchanged', () => {
    const { container } = wrap(<ChangePasswordForm onSuccess={() => {}} />);
    const submit = screen.getByRole("button", { name: "Change password" });
    expect(submit).toHaveClass("bg-brand", "w-full", "h-11");
    for (const id of PASSWORD_FIELD_IDS) {
      expect(container.querySelector(`#${id}`)).toHaveClass("h-11");
    }
  });

  it("SetPasswordForm submit button is outline", () => {
    wrap(<SetPasswordForm onSuccess={() => {}} />);
    const submit = screen.getByRole("button", { name: "Add password" });
    expect(submit).toHaveClass("border-input");
    expect(submit).not.toHaveClass("bg-brand-deep");
  });
});
