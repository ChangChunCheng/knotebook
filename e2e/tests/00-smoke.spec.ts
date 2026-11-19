import { test, expect } from "@playwright/test";

/**
 * Smoke spec: the compose stack comes up and the app is reachable; the OIDC/AI stubs are left to later specs.
 * Run via ../../scripts/test-e2e.sh, which owns the stack lifecycle (this file does not).
 */

test("GET /healthz returns {ok:true}", async ({ request }) => {
  const response = await request.get("/healthz");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});

test("/login renders the sign-in form", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("#login-email")).toBeVisible();
  await expect(page.locator("#login-password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

// #336: server unit tests use a hand-written fake dist, which cannot prove the real image ships these files with the right MIME types.
test("GET /manifest.webmanifest is application/manifest+json, and every manifest icon and the apple-touch-icon return 200 image/png", async ({
  request,
}) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/manifest+json");
  expect(response.headers()["cache-control"]).toBe("no-cache");

  const manifest = (await response.json()) as { icons: { src: string }[] };
  // Assert non-empty first: an empty array would make the loop below pass vacuously.
  expect(manifest.icons.length).toBeGreaterThan(0);
  for (const icon of manifest.icons) {
    const iconResponse = await request.get(icon.src);
    expect(iconResponse.status(), icon.src).toBe(200);
    expect(iconResponse.headers()["content-type"], icon.src).toContain("image/png");
    expect(iconResponse.headers()["cache-control"], icon.src).toBe("no-cache");
  }

  // The iOS home-screen icon comes from index.html's <link rel="apple-touch-icon">, not from the manifest.
  const touchIcon = await request.get("/apple-touch-icon.png");
  expect(touchIcon.status()).toBe(200);
  expect(touchIcon.headers()["content-type"]).toContain("image/png");
  expect(touchIcon.headers()["cache-control"]).toBe("no-cache");
});

test("index.html is no-cache; its entry script (hashed name under /assets/) is cached for a year and immutable", async ({ request }) => {
  const html = await request.get("/", { headers: { accept: "text/html" } });
  expect(html.status()).toBe(200);
  expect(html.headers()["cache-control"]).toBe("no-cache");

  const entry = (await html.text()).match(/<script\b[^>]*\bsrc="(\/assets\/index-[^"]+\.js)"/)?.[1];
  expect(entry, "index.html 裡找不到 /assets/index-*.js").toBeDefined();
  const script = await request.get(entry!);
  expect(script.status()).toBe(200);
  expect(script.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
});

// <meta name="theme-color"> is a hard-coded hex (a stable status-bar value) while the page background is an oklch token in index.css.
// Draw the body's computed background onto a canvas to get sRGB and compare, so a token change without the hex fails.
// The device colour scheme is deliberately opposite to the app theme: the meta must follow the theme chosen in the app.
for (const theme of ["light", "dark"] as const) {
  test(`theme-color matches the page background of the ${theme} theme (device scheme opposite)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme === "dark" ? "light" : "dark" });
    await page.addInitScript((value) => window.localStorage.setItem("knotebook:theme", value), theme);
    await page.goto("/login");
    await expect(page.locator("#login-email")).toBeVisible();
    if (theme === "dark") await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    // At first paint the two metas hold one value per device scheme; after React mounts both switch to the app theme's value
    await expect
      .poll(() =>
        page.evaluate(
          () => new Set([...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content"))).size,
        ),
      )
      .toBe(1);

    const { body, metas } = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return {
        body: [r, g, b],
        metas: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content") ?? ""),
      };
    });

    expect(metas).toHaveLength(2);
    for (const hex of metas) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
      const meta = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      // oklch -> sRGB rounding can differ by 1
      for (let i = 0; i < 3; i++) expect(Math.abs(meta[i] - body[i]), `${hex} vs rgb(${body.join(", ")})`).toBeLessThanOrEqual(1);
    }
  });
}
