#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = join(REPO_ROOT, 'apps', 'web', 'public');

const VIEWBOX = 64;

// 0.79 matches apple-touch-icon.png; 0.6 keeps the glyph inside the maskable safe circle (80% of the diameter).
export const ICONS = [
  { file: 'icon-192.png', size: 192, scale: 0.79 },
  { file: 'icon-512.png', size: 512, scale: 0.79 },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.6 },
];

export function extractGlyphPath(svg) {
  const matches = [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)];
  if (matches.length !== 1) throw new Error(`favicon.svg 應該恰有一條 <path d>，實際 ${matches.length} 條`);
  return matches[0][1];
}

// Light-scheme fill; the dark one sits inside a media query.
export function extractBrandFill(svg) {
  const match = /path\s*\{\s*fill:\s*(#[0-9a-f]{6})\s*;?\s*\}/i.exec(svg);
  if (!match) throw new Error('favicon.svg 找不到 `path { fill: #xxxxxx; }`');
  return match[1].toLowerCase();
}

// The background fills the whole square (no transparent edge) so Android mask shapes never show anything but the brand color.
export function iconSvg({ glyphPath, background, scale, size }) {
  const offset = (VIEWBOX * (1 - scale)) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}" width="${size}" height="${size}">` +
    `<rect width="${VIEWBOX}" height="${VIEWBOX}" fill="${background}"/>` +
    `<path transform="translate(${offset} ${offset}) scale(${scale})" fill="#ffffff" d="${glyphPath}"/>` +
    `</svg>`
  );
}

function parseArgs(argv) {
  const outIndex = argv.indexOf('--out');
  return { outDir: outIndex === -1 ? PUBLIC_DIR : resolve(argv[outIndex + 1] ?? '') };
}

async function main() {
  const { outDir } = parseArgs(process.argv.slice(2));
  const favicon = readFileSync(join(PUBLIC_DIR, 'favicon.svg'), 'utf8');
  const glyphPath = extractGlyphPath(favicon);
  const background = extractBrandFill(favicon);

  // Rasterized with the e2e package's Playwright Chromium (needs pnpm install and `playwright install chromium`).
  const requireFromE2e = createRequire(join(REPO_ROOT, 'e2e', 'package.json'));
  const { chromium } = requireFromE2e('@playwright/test');
  const browser = await chromium.launch();
  try {
    mkdirSync(outDir, { recursive: true });
    for (const icon of ICONS) {
      const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size }, deviceScaleFactor: 1 });
      const svg = iconSvg({ glyphPath, background, scale: icon.scale, size: icon.size });
      await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
      const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: icon.size, height: icon.size } });
      writeFileSync(join(outDir, icon.file), png);
      await page.close();
      console.log(`${icon.file}：${icon.size}×${icon.size}，字形縮放 ${icon.scale}`);
    }
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
