import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_COLOR } from "./theme";

// #336 install as an app: can be added to the home screen and opened standalone; no service worker / offline.
// This only checks the files as handed out: manifest fields, icon files and their real sizes, the link / meta tags in index.html.
// Whether the server sends the manifest with the right MIME and keeps the SPA fallback from swallowing it is covered in apps/server/test/spa.test.ts.

const publicDir = `${process.cwd()}/public`;
const indexHtml = readFileSync(`${process.cwd()}/index.html`, "utf8");
// Strip HTML comments first: a commented-out <link> / <meta> doesn't exist in the browser and mustn't count.
const head = indexHtml.slice(indexHtml.indexOf("<head>"), indexHtml.indexOf("</head>")).replace(/<!--[\s\S]*?-->/g, "");
// The trailing **comment** on the --background lines in index.css records the light / dark hex pairs (one each for :root and :root.dark). Warning: this compares the comment,
// not the actual oklch value, so changing the oklch without the comment leaves these tests green. The actual value is compared in a real browser by e2e/tests/00-smoke.spec.ts.
const backgroundHexes = [...readFileSync(`${process.cwd()}/src/index.css`, "utf8").matchAll(/(?<![\w-])--background:[^;]*;\s*\/\*\s*(#[0-9a-f]{6})/gi)].map((m) => m[1].toLowerCase());

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
interface Manifest {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(`${publicDir}/manifest.webmanifest`, "utf8")) as Manifest;
}

/** PNG header: 8-byte signature, then the IHDR chunk (length 4, type 4); width and height are 4 bytes each, big-endian, at offsets 16 / 20. */
function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  expect(buf.subarray(0, 8).toString("hex"), `${file} 不是 PNG`).toBe("89504e470d0a1a0a");
  expect(buf.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const HEX = /^#[0-9a-f]{6}$/i;

describe("pngSize (the measuring helper itself)", () => {
  it("known-size PNG: apple-touch-icon.png measures 180x180", () => {
    expect(pngSize(`${publicDir}/apple-touch-icon.png`)).toEqual({ width: 180, height: 180 });
  });
  it("a non-PNG file (favicon.svg) makes pngSize fail", () => {
    expect(() => pngSize(`${publicDir}/favicon.svg`)).toThrow();
  });
});

describe("manifest.webmanifest (#336)", () => {
  it("file exists and is valid JSON", () => {
    expect(existsSync(`${publicDir}/manifest.webmanifest`)).toBe(true);
    expect(() => readManifest()).not.toThrow();
  });

  it("required installability fields: name / short_name, start_url and scope at the site root, display standalone", () => {
    const m = readManifest();
    expect(m.name).toBe("Knotebook");
    expect(m.short_name).toBe("Knotebook");
    // id pins the app identity: if unset, browsers use start_url, so changing start_url later would turn already-installed apps into a different app (#336, Chrome DevTools recommendation)
    expect(m.id).toBe("/");
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
  });

  it("doesn't lock orientation: the manifest has no orientation field, the device decides", () => {
    expect(readManifest()).not.toHaveProperty("orientation");
  });

  it("theme_color / background_color are 6-digit hex", () => {
    const m = readManifest();
    expect(m.theme_color).toMatch(HEX);
    expect(m.background_color).toMatch(HEX);
  });

  it("icons: 192 and 512 PNGs (purpose any), plus one maskable", () => {
    const icons = readManifest().icons;
    const any = icons.filter((i) => (i.purpose ?? "any").split(" ").includes("any"));
    expect(any.map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
    expect(icons.some((i) => (i.purpose ?? "").split(" ").includes("maskable"))).toBe(true);
    for (const icon of icons) expect(icon.type).toBe("image/png");
  });

  it("every icon file exists in public/, and its real pixel size matches the declared sizes", () => {
    for (const icon of readManifest().icons) {
      expect(icon.src.startsWith("/"), icon.src).toBe(true);
      const file = `${publicDir}${icon.src}`;
      expect(existsSync(file), file).toBe(true);
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(pngSize(file), icon.src).toEqual({ width: w, height: h });
    }
  });
});

describe("PWA markup in index.html (#336)", () => {
  it("has exactly one <link rel=\"manifest\" href=\"/manifest.webmanifest\">", () => {
    const links = head.match(/<link\s+rel="manifest"[^>]*>/g) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toContain('href="/manifest.webmanifest"');
  });

  it("the --background comment in index.css has exactly one light and one dark hex (the source for the next comparison; fails if it can't find them instead of silently skipping)", () => {
    expect(backgroundHexes).toHaveLength(2);
  });

  it("theme-color has light and dark variants (prefers-color-scheme): light = manifest theme_color = the page-background comment hex, dark = the dark page-background comment hex", () => {
    const metas = head.match(/<meta\s+name="theme-color"[^>]*>/g) ?? [];
    expect(metas).toHaveLength(2);
    const light = metas.find((m) => m.includes("(prefers-color-scheme: light)"));
    const dark = metas.find((m) => m.includes("(prefers-color-scheme: dark)"));
    expect(light, "缺淺色 theme-color").toBeDefined();
    expect(dark, "缺深色 theme-color").toBeDefined();
    expect(light).toContain(`content="${readManifest().theme_color}"`);
    expect(readManifest().theme_color.toLowerCase()).toBe(backgroundHexes[0]);
    expect(dark?.toLowerCase()).toContain(`content="${backgroundHexes[1]}"`);
  });

  it("THEME_COLOR in theme.tsx = initial content of both theme-color tags in index.html = manifest theme_color (light): the runtime sync and the first-paint markup must agree", () => {
    const metas = head.match(/<meta\s+name="theme-color"[^>]*>/g) ?? [];
    const contentOf = (media: string) => metas.find((m) => m.includes(media))?.match(/content="([^"]*)"/)?.[1];
    expect(contentOf("(prefers-color-scheme: light)")).toBe(THEME_COLOR.light);
    expect(contentOf("(prefers-color-scheme: dark)")).toBe(THEME_COLOR.dark);
    expect(readManifest().theme_color).toBe(THEME_COLOR.light);
  });

  it("the raw head (comments included) contains `<script` exactly once: INLINE_SCRIPT in security-headers.ts hashes the HTML with comments unstripped, so a literal `<script ...>` inside a comment would be hashed too", () => {
    const rawHead = indexHtml.slice(indexHtml.indexOf("<head>"), indexHtml.indexOf("</head>"));
    expect(rawHead.match(/<script/gi) ?? []).toHaveLength(1);
  });

  it("still only one inline script (theme.test.tsx checks only the first for flash prevention; PWA markup must not add another inline script)", () => {
    const inline = head.match(/<script(?![^>]*\ssrc=)[^>]*>/g) ?? [];
    expect(inline).toHaveLength(1);
  });
});
