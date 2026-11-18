# Third-Party Notices

Knotebook's own code is MIT-licensed (see [LICENSE](./LICENSE)). This file lists
bundled third-party assets that carry a different license.

## Playfair Display (font)

- **Package:** [`@fontsource/playfair-display`](https://www.npmjs.com/package/@fontsource/playfair-display) — bundled as a static font asset in the web app's build output (the sidebar logo's "K"). The browser-tab icon (`apps/web/public/favicon.svg`), the iOS home-screen icon (`apple-touch-icon.png`) and the installed-app icons (`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`) are drawn from that font's bold italic "K" glyph (converted to an SVG path with opentype.js from `files/playfair-display-latin-700-italic.woff`; the recipe is in the comment inside `favicon.svg`). The installed-app icons are that path in white on a full-bleed `#676f97` square, rasterized in Chromium by `scripts/generate-pwa-icons.mjs`: scaled 0.79 about the centre of the 64-unit box for `icon-192.png` and `icon-512.png` (matching `apple-touch-icon.png`), 0.6 for `icon-maskable-512.png` so the glyph stays inside the maskable safe zone.
- **Copyright:** Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display), with Reserved Font Name "Playfair Display".
- **License:** SIL Open Font License, Version 1.1 (OFL-1.1).
- **Full license text:** the `LICENSE` file inside the installed package (`node_modules/@fontsource/playfair-display/LICENSE`), also available at https://scripts.sil.org/OFL.

## jsdiff (`diff`)

- **Package:** [`diff`](https://www.npmjs.com/package/diff) — bundled into the web app's build output (the version-history preview compares two versions of a note with it).
- **Copyright:** Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>.
- **License:** BSD 3-Clause License (BSD-3-Clause).
- **Full license text:** the `LICENSE` file inside the installed package (`node_modules/diff/LICENSE`).

## BlockNote (`@blocknote/core`, modified)

- **Package:** [`@blocknote/core`](https://www.npmjs.com/package/@blocknote/core) 0.52.1 — bundled into the web app's build output (the note editor) and shipped in the container image. Its source code is at https://github.com/TypeCellOS/BlockNote (`packages/core`). `@blocknote/react` and `@blocknote/mantine` 0.52.1, which the web app also bundles, are under the same license and are not modified.
- **License:** Mozilla Public License, Version 2.0 (MPL-2.0).
- **Full license text:** the `LICENSE` file inside the installed package (`node_modules/@blocknote/core/LICENSE`), also available at https://www.mozilla.org/MPL/2.0/.
- **Modification:** Knotebook ships `@blocknote/core` modified. The only change is [`patches/@blocknote__core@0.52.1.patch`](./patches/@blocknote__core@0.52.1.patch) in this repository, applied with `pnpm patch`: it adds `<` to the characters a backslash can escape in the package's Markdown parser.
