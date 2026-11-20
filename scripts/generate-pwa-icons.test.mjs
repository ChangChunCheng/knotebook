// Covers the parts of generate-pwa-icons.mjs that do not open a browser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { ICONS, extractBrandFill, extractGlyphPath, iconSvg } from './generate-pwa-icons.mjs';

const favicon = readFileSync(new URL('../apps/web/public/favicon.svg', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../apps/web/public/manifest.webmanifest', import.meta.url), 'utf8'));

test('extractGlyphPath: favicon.svg has exactly one path, take its d', () => {
  const d = extractGlyphPath(favicon);
  assert.match(d, /^M[\d.]+ [\d.]+/);
  assert.throws(() => extractGlyphPath('<svg></svg>'), /恰有一條/);
  assert.throws(() => extractGlyphPath('<svg><path d="M0 0"/><path d="M1 1"/></svg>'), /恰有一條/);
});

test('extractBrandFill: takes the light fill (the first one in style), not the one inside the dark media query', () => {
  assert.equal(extractBrandFill(favicon), '#676f97');
  assert.throws(() => extractBrandFill('<svg></svg>'));
});

test('iconSvg: full-bleed background colour, glyph scaled about the centre of the 64 square', () => {
  const svg = iconSvg({ glyphPath: 'M0 0', background: '#123456', scale: 0.6, size: 512 });
  assert.match(svg, /width="512" height="512"/);
  assert.match(svg, /<rect width="64" height="64" fill="#123456"\/>/);
  // (64 - 64 × 0.6) / 2 = 12.8
  assert.match(svg, /transform="translate\(12\.8 12\.8\) scale\(0\.6\)"/);
  assert.match(svg, /fill="#ffffff" d="M0 0"/);
});

test('ICONS match the manifest icons one to one (file names, sizes); the maskable one is scaled smaller', () => {
  const declared = manifest.icons.map((i) => `${i.src.slice(1)} ${i.sizes}`).sort();
  const generated = ICONS.map((i) => `${i.file} ${i.size}x${i.size}`).sort();
  assert.deepEqual(generated, declared);
  const maskable = manifest.icons.find((i) => i.purpose === 'maskable');
  const maskableIcon = ICONS.find((i) => `/${i.file}` === maskable.src);
  for (const icon of ICONS) if (icon !== maskableIcon) assert.ok(maskableIcon.scale < icon.scale);
});
