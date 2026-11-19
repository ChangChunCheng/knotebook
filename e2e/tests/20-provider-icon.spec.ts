import path from "node:path";
import { test, expect } from "@playwright/test";
import { ADMIN, loginAs, solidPng } from "./helpers.js";

/**
 * No provider is added (05 etc. locate the SSO button by name). The test asserts iconKind === "template" before starting (it
 * fails otherwise; no guessing how to restore, since PATCH does not accept upload) and always restores it in finally.
 * Screenshots for visual inspection: taken only when `PROVIDER_ICON_SCREENSHOT_DIR` is set, otherwise skipped; this file
 * writes no absolute path.
 */

test("20-1: admin uploads an icon for SSO -> the sign-in page SSO button shows the uploaded image downscaled to 128x64", async ({ browser }) => {
  const shotDir = process.env.PROVIDER_ICON_SCREENSHOT_DIR;
  const adminContext = await browser.newContext();
  try {
    const page = await adminContext.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await expect(page).toHaveURL(/\/$/);
    const list = (await (await page.request.get("/api/admin/auth/providers")).json()) as {
      providers: Array<{ id: string; displayName: string; iconKind: string }>;
    };
    const sso = list.providers.find(p => p.displayName === "SSO");
    expect(sso, "e2e 疊應有 global-setup 建的 SSO").toBeDefined();
    // The restore target is fixed at template: if the precondition is not template, the finally restore would corrupt the original state, so fail straight away (and do not try to restore: PATCH does not accept upload).
    // If a run is interrupted after the upload and before the restore, a dirty stack keeps failing this precondition; the fix is stack:down (with -v to clear volumes) and starting again. The outer finally still closes adminContext.
    expect(sso!.iconKind).toBe("template");

    // A restore failure must not mask the body's original error: if the body already failed, only console.error the restore error and rethrow the original; throw the restore error only when the body succeeded.
    let failure: unknown;
    try {
      await page.goto("/admin/login");
      const card = page.getByRole("row", { name: sso!.displayName, exact: true });
      await card.getByRole("button", { name: "Icon", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Sign-in service icon" });
      await dialog.getByRole("radio", { name: "Upload an image" }).check();
      await dialog.locator('input[type="file"]').setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: solidPng(256, 128) });
      await expect(dialog.locator('img[data-provider-icon="upload"]')).toHaveAttribute("src", /^blob:/);
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(card.locator('img[data-provider-icon="upload"]')).toHaveAttribute("src", new RegExp(`^/api/auth/providers/${sso!.id}/icon\\?v=\\d+$`));

      const anon = await browser.newContext();
      try {
        const p = await anon.newPage();
        await p.goto("/login");
        const ssoLink = p.getByRole("link", { name: "Sign in with SSO", exact: true });
        const img = ssoLink.locator('img[data-provider-icon="upload"]');
        await expect(img).toHaveAttribute("src", /\?v=\d+$/);
        await expect
          .poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? `${el.naturalWidth}x${el.naturalHeight}` : "loading")), {
            message: "登入頁 SSO 鈕的上傳圖應載入完成且為瀏覽器縮過的 128×64（naturalWidth×naturalHeight）",
          })
          .toBe("128x64");
        if (shotDir) await ssoLink.locator("..").screenshot({ path: path.join(shotDir, "20-login-sso-icon.png") });
      } finally {
        await anon.close();
      }
    } catch (error) {
      failure = error;
    }

    let restoreError: unknown;
    try {
      const res = await page.request.patch(`/api/admin/auth/providers/${sso!.id}`, { data: { iconKind: "template" } });
      if (!res.ok()) restoreError = new Error(`還原 iconKind=template 失敗：HTTP ${res.status()} ${await res.text()}`);
    } catch (error) {
      restoreError = error;
    }
    if (failure !== undefined) {
      if (restoreError !== undefined) console.error("還原 iconKind=template 也失敗（以下為還原錯；拋出的是測試本體的原錯）：", restoreError);
      throw failure;
    }
    if (restoreError !== undefined) throw restoreError;
  } finally {
    await adminContext.close();
  }
});
