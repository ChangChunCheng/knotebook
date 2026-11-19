import { expect, test } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * issue #101: end-to-end check of CSP. Unit tests (`security-headers.test.ts`) pin the policy content and integration tests
 * (`spa.test.ts`) pin that the header is attached and the hash derives from the body actually sent; what only a real
 * browser can show is **whether this policy blocks our own things**:
 *
 * 1. The first-paint anti-flash inline script must pass (when blocked the symptom is dark mode **flashing white on every
 *    page open** and no unit test goes red; this is the main regression risk of that issue);
 * 2. The collab WebSocket (`wss://<same host>/collab`) must connect (whether `connect-src 'self'` covers same-origin ws has
 *    been inconsistent across browsers);
 * 3. Injections the editor actually uses must not trigger a violation: shiki's token inline style, the slash menu (a
 *    BlockNote overlay), mermaid's lazy chunk and its generated SVG.
 *
 * The criterion is the **CSP violation the browser itself reports** (the `securitypolicyviolation` event), not console
 * string matching, which silently breaks when a browser rewords its message.
 */

interface Violation {
  directive: string;
  blockedURI: string;
}

test("note + code block + diagram + collab connection: browser reports zero CSP violations", async ({ page }) => {
  const violations: Violation[] = [];
  // Registered before any page script, so a blocked first-paint inline script is caught.
  await page.addInitScript(() => {
    (window as unknown as { __cspViolations: Violation[] }).__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __cspViolations: Violation[] }).__cspViolations.push({
        directive: event.violatedDirective,
        blockedURI: event.blockedURI,
      });
    });
  });

  // Move the violations received on the current page into the test side. This file currently has a single real document
  // navigation (`page.goto("/login")`); later note switches are react-router client-side navigations, so the collector is
  // not reset by addInitScript. Draining is therefore defensive: if someone adds a full-page navigation in between, without
  // a drain the previous page's evidence would be lost. (The array is not cleared, so one violation can be counted twice,
  // which only affects the error message, not the verdict.)
  const drain = async () => {
    const collected = await page.evaluate(
      () => (window as unknown as { __cspViolations: Violation[] }).__cspViolations,
    );
    violations.push(...collected);
  };

  await loginAs(page, ADMIN.email, ADMIN.password);

  await createNote(page, `E2E csp code ${Date.now()}`);
  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("```ts ");
  await editor.pressSequentially('const x = "hi"');
  await expect(page.locator('[data-testid="note-editor"] .shiki').first()).toBeVisible({ timeout: 20_000 });
  await drain();

  // Page 2: mermaid (lazy chunk + injected inline style + generated SVG + the slash menu, a BlockNote overlay). Use a
  // separate note rather than continuing above: if the caret is still in the code block, `/diagram` is taken as code text
  // and the slash menu does not open.
  await createNote(page, `E2E csp diagram ${Date.now()}`);
  const editor2 = editorLocator(page);
  await editor2.click();
  await editor2.pressSequentially("/diagram");
  await page.getByText("Flowcharts and diagrams with Mermaid").click();
  await page.getByRole("button", { name: "Edit diagram source" }).click();
  const source = page.getByRole("textbox", { name: "Mermaid source" });
  await source.fill("flowchart TD\n  A[Start] --> B[End]");
  await source.press("Escape");
  await expect(editorLocator(page).locator("svg[aria-roledescription]").first()).toBeVisible({
    timeout: 20_000,
  });

  // The Connected badge means the WebSocket was not blocked by connect-src
  await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 20_000 });

  // If the first-paint anti-flash script were blocked, the browser would emit a script-src violation, which the overall
  // assertion below covers (no separate claim that "the script ran": that needs timing evidence, and looking at violations
  // directly is better).
  const csp = await page.evaluate(() =>
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
  );
  expect(csp, "CSP 不該用 <meta> 帶（本專案由 server 標頭帶，meta 會多一份難同步的真相）").toBeUndefined();

  await drain();
  expect(violations, `CSP 擋到了自己的東西：${JSON.stringify(violations)}`).toEqual([]);

  // Positive control: the zero-violation assertion above would also be green if no CSP were sent at all (a false-green shape
  // that recurs in this repo). So prove the policy is in force in **this browser**: inject an inline script, which must be
  // blocked (not run) and produce a script-src violation.
  const pwned = await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__cspPositiveControl = true;";
    document.head.appendChild(script);
    return (window as unknown as { __cspPositiveControl?: boolean }).__cspPositiveControl ?? false;
  });
  expect(pwned, "注入的 inline script 竟然執行了——CSP 沒有生效，上面的零 violation 是假綠").toBe(false);

  const afterControl = await page.evaluate(
    () => (window as unknown as { __cspViolations: Violation[] }).__cspViolations,
  );
  // The match must accept the script-src **family**: for a `<script>` **element** Chromium reports `violatedDirective` as
  // `script-src-elem` (a refinement of script-src in the spec), not `script-src`; hard-coding the latter would keep this
  // positive control permanently red.
  expect(
    afterControl.some((v) => v.directive.startsWith("script-src")),
    `正向對照沒有拿到 script-src 家族的 violation：${JSON.stringify(afterControl)}`,
  ).toBe(true);
});
