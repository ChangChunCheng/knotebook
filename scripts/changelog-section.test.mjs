// Fail-closed on a missing or empty version so CI never publishes a release with blank notes.
// The trailing `## Documentation` section is a real case: it must not be read as part of a version.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractChangelogSection } from './changelog-section.mjs';

const CHANGELOG = [
  '# Changelog',
  '',
  'All notable changes to this project are documented here.',
  '',
  '## [Unreleased]',
  '',
  '- 尚未發版的東西。',
  '',
  '## [0.2.0] - 2026-09-01',
  '',
  '### Added',
  '- 新東西 B。',
  '',
  '## [0.1.0] - 2026-08-14',
  '',
  '### Added',
  '- 新東西 A。',
  '',
  '### Security',
  '- 安全性修補 A。',
  '',
  '## Documentation',
  '',
  '- [README](README.md) — 檔尾章節，不屬於任何版本。',
  '',
].join('\n');

test('extractChangelogSection: extracts the requested version without its heading line', () => {
  const section = extractChangelogSection(CHANGELOG, '0.1.0');

  assert.equal(section, ['### Added', '- 新東西 A。', '', '### Security', '- 安全性修補 A。'].join('\n'));
});

test('extractChangelogSection: stops at the next version heading', () => {
  const section = extractChangelogSection(CHANGELOG, '0.2.0');

  assert.equal(section, ['### Added', '- 新東西 B。'].join('\n'));
  assert.ok(!section.includes('0.1.0'));
  assert.ok(!section.includes('新東西 A'));
});

test('extractChangelogSection: stops at a trailing non-version `## ` section', () => {
  const section = extractChangelogSection(CHANGELOG, '0.1.0');

  assert.ok(!section.includes('Documentation'));
  assert.ok(!section.includes('檔尾章節'));
});

test('extractChangelogSection: throws for a missing version, with the version in the message', () => {
  assert.throws(() => extractChangelogSection(CHANGELOG, '9.9.9'), /9\.9\.9/);
});

test('extractChangelogSection: does not attribute [Unreleased] content to any version', () => {
  const section = extractChangelogSection(CHANGELOG, '0.2.0');

  assert.ok(!section.includes('尚未發版'));
});

test('extractChangelogSection: throws when the version exists but its body is empty', () => {
  const emptySection = ['# Changelog', '', '## [0.3.0] - 2026-10-01', '', '## [0.2.0] - 2026-09-01', '', '- x。', ''].join('\n');

  assert.throws(() => extractChangelogSection(emptySection, '0.3.0'), /0\.3\.0/);
});
