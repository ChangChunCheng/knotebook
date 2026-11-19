#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HEADING_PREFIX = '## ';

export function extractChangelogSection(changelogText, version) {
  const versionHeading = `${HEADING_PREFIX}[${version}]`;
  const lines = changelogText.split('\n');
  const start = lines.findIndex((line) => line.startsWith(versionHeading));

  if (start === -1) {
    throw new Error(`CHANGELOG.md 裡找不到版本 ${version} 的段落（預期標題形如 "${versionHeading} - YYYY-MM-DD"）`);
  }

  // Ends at any `## ` heading, not only version headings: the file tail has non-version sections.
  const rest = lines.slice(start + 1);
  const endOffset = rest.findIndex((line) => line.startsWith(HEADING_PREFIX));
  const body = (endOffset === -1 ? rest : rest.slice(0, endOffset)).join('\n').trim();

  // Fail closed so the release workflow goes red instead of publishing empty notes.
  if (body === '') {
    throw new Error(`CHANGELOG.md 裡版本 ${version} 的段落是空的——不發 notes 空白的 release`);
  }

  return body;
}

function main(argv) {
  const version = argv[2];

  if (!version) {
    throw new Error('用法：node scripts/changelog-section.mjs <version>（例：0.1.0）');
  }

  const changelogPath = new URL('../CHANGELOG.md', import.meta.url);

  process.stdout.write(`${extractChangelogSection(readFileSync(changelogPath, 'utf8'), version)}\n`);
}

// argv[1] is undefined under `node -e`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
