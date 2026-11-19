// Each test builds a fake repo in a temp directory (three package.json files, CHANGELOG, two READMEs); the tag list and date are injected by parameters, so the real repo is untouched and git is not called.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';

import { localDate, maxReleaseTag, parseArgs, runReleasePrepare } from './release-prepare.mjs';

const PKG = (name) => ['{', `  "name": "${name}",`, '  "version": "0.11.1",', '  "private": true,', '  "dependencies": {', '    "x": "1.0.0"', '  }', '}', ''];

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '- 新功能。',
  '',
  '## [0.11.1] - 2026-10-15',
  '',
  '### Fixed',
  '',
  '- 舊修正。',
  '',
  '## Documentation',
  '',
];

const README = ['# Knotebook', '', '**Status:** the latest release is v0.11.1 (2026-10-15). What it does today:', ''];
const README_ZH = ['# Knotebook', '', '**狀態**：最新版本為 v0.11.1（2026-10-15）。目前具備的功能：', ''];

const TAGS = ['v0.1.0', 'v0.10.0', 'v0.11.1', 'v0.9.0', 'v1.0.0-rc1', 'foo'];

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function makeRepo({ eol = '\r\n', changelog = CHANGELOG, readme = README, readmeZh = README_ZH } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'release-prepare-'));
  roots.push(root);
  const files = {
    'apps/server/package.json': PKG('@knotebook/server'),
    'apps/web/package.json': PKG('@knotebook/web'),
    'packages/shared/package.json': PKG('@knotebook/shared'),
    'CHANGELOG.md': changelog,
    'README.md': readme,
    'README.zh-TW.md': readmeZh,
  };
  for (const [path, lines] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), lines.join(eol), 'utf8');
  }
  return root;
}

function snapshot(root) {
  const paths = ['apps/server/package.json', 'apps/web/package.json', 'packages/shared/package.json', 'CHANGELOG.md', 'README.md', 'README.zh-TW.md'];
  return Object.fromEntries(paths.map((p) => [p, readFileSync(join(root, p))]));
}

function read(root, path) {
  return readFileSync(join(root, path), 'utf8');
}

function assertFails(root, args, messagePattern) {
  const before = snapshot(root);
  assert.throws(() => runReleasePrepare({ root, date: '2026-10-20', tags: TAGS, ...args }), messagePattern);
  assert.deepEqual(snapshot(root), before, '失敗時不得改任何檔');
}

test('success: three package.json files, the CHANGELOG and both READMEs are updated, the date uses the injected value', () => {
  const root = makeRepo();
  const result = runReleasePrepare({ root, version: '0.12.0', date: '2026-10-20', tags: TAGS });

  assert.equal(result.date, '2026-10-20');
  for (const path of ['apps/server/package.json', 'apps/web/package.json', 'packages/shared/package.json']) {
    const pkg = JSON.parse(read(root, path));
    assert.equal(pkg.version, '0.12.0', path);
    assert.equal(pkg.dependencies.x, '1.0.0', `${path} 其他欄位不動`);
  }
  assert.equal(
    read(root, 'CHANGELOG.md'),
    [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '_Nothing yet._',
      '',
      '## [0.12.0] - 2026-10-20',
      '',
      '### Added',
      '',
      '- 新功能。',
      '',
      '## [0.11.1] - 2026-10-15',
      '',
      '### Fixed',
      '',
      '- 舊修正。',
      '',
      '## Documentation',
      '',
    ].join('\r\n'),
  );
  assert.match(read(root, 'README.md'), /the latest release is v0\.12\.0 \(2026-10-20\)\. What/);
  assert.match(read(root, 'README.zh-TW.md'), /最新版本為 v0\.12\.0（2026-10-20）。目前/);
});

test('a CRLF file stays CRLF (no lone LF appears)', () => {
  const root = makeRepo({ eol: '\r\n' });
  runReleasePrepare({ root, version: '0.12.0', date: '2026-10-20', tags: TAGS });
  for (const [path, bytes] of Object.entries(snapshot(root))) {
    const text = bytes.toString('utf8');
    assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, `${path} 出現單獨的 LF`);
    assert.ok(text.includes('\r\n'), path);
  }
});

test('an LF file stays LF', () => {
  const root = makeRepo({ eol: '\n' });
  runReleasePrepare({ root, version: '0.12.0', date: '2026-10-20', tags: TAGS });
  for (const [path, bytes] of Object.entries(snapshot(root))) {
    assert.equal(bytes.toString('utf8').includes('\r'), false, path);
  }
});

test('the first release can be made when there are no tags', () => {
  const root = makeRepo();
  runReleasePrepare({ root, version: '0.1.0', date: '2026-10-20', tags: [] });
  assert.equal(JSON.parse(read(root, 'apps/web/package.json')).version, '0.1.0');
});

test('failure: version format mismatch (with v, one segment short, leading zero, prerelease) -> files unchanged', () => {
  const root = makeRepo();
  for (const version of ['v0.12.0', '0.12', '0.012.0', '0.12.0-rc1', '', undefined]) {
    assertFails(root, { version }, /版號形式不符/);
  }
});

test('failure: version not greater than the existing largest tag (equal or smaller, compared as semver rather than strings) -> files unchanged', () => {
  const root = makeRepo();
  assertFails(root, { version: '0.11.1' }, /必須大於既有最大 tag v0\.11\.1/);
  assertFails(root, { version: '0.9.9' }, /必須大於既有最大 tag v0\.11\.1/);
});

test('failure: date format mismatch -> files unchanged', () => {
  const root = makeRepo();
  assertFails(root, { version: '0.12.0', date: '2026/10/20' }, /日期形式不符/);
});

test('failure: [Unreleased] is _Nothing yet._ -> files unchanged', () => {
  const root = makeRepo({ changelog: ['# Changelog', '', '## [Unreleased]', '', '_Nothing yet._', '', '## [0.11.1] - 2026-10-15', '', '- x', ''] });
  assertFails(root, { version: '0.12.0' }, /\[Unreleased\] 是空的/);
});

test('failure: [Unreleased] has no content -> files unchanged', () => {
  const root = makeRepo({ changelog: ['# Changelog', '', '## [Unreleased]', '', '', '## [0.11.1] - 2026-10-15', '', '- x', ''] });
  assertFails(root, { version: '0.12.0' }, /\[Unreleased\] 是空的/);
});

test('failure: the [Unreleased] heading is not found -> files unchanged', () => {
  const root = makeRepo({ changelog: ['# Changelog', '', '## [0.11.1] - 2026-10-15', '', '- x', ''] });
  assertFails(root, { version: '0.12.0' }, /找不到 "## \[Unreleased\]"/);
});

test('failure: the CHANGELOG already has a section for that version -> files unchanged', () => {
  const root = makeRepo({ changelog: ['## [Unreleased]', '', '- y', '', '## [0.12.0] - 2026-10-01', '', '- x', ''] });
  assertFails(root, { version: '0.12.0', tags: ['v0.11.1'] }, /已經有 0\.12\.0 的段落/);
});

test('failure: the README status line is not found (English or Chinese) -> files unchanged', () => {
  const noEn = makeRepo({ readme: ['# Knotebook', '', 'Status: v0.11.1', ''] });
  assertFails(noEn, { version: '0.12.0' }, /README\.md 的狀態行應恰好 1 處，實際 0 處/);
  const noZh = makeRepo({ readmeZh: ['# Knotebook', '', '狀態：v0.11.1', ''] });
  assertFails(noZh, { version: '0.12.0' }, /README\.zh-TW\.md 的狀態行應恰好 1 處，實際 0 處/);
});

test('failure: the README status line appears twice -> files unchanged', () => {
  const root = makeRepo({ readme: [...README, README[2], ''] });
  assertFails(root, { version: '0.12.0' }, /README\.md 的狀態行應恰好 1 處，實際 2 處/);
});

test('failure: the first "version" in package.json is not the top-level one -> files unchanged', () => {
  const root = makeRepo();
  const nested = ['{', '  "name": "@knotebook/web",', '  "engines": { "x": { "version": "1.0.0" } },', '  "version": "0.11.1"', '}', ''];
  writeFileSync(join(root, 'apps/web/package.json'), nested.join('\r\n'), 'utf8');
  assertFails(root, { version: '0.12.0' }, /apps\/web\/package\.json 的頂層 "version" 不是檔內第一個 "version"/);
});

test('failure: package.json has no version or is not valid JSON -> files unchanged', () => {
  const noVersion = makeRepo();
  writeFileSync(join(noVersion, 'packages/shared/package.json'), '{ "name": "x" }\r\n', 'utf8');
  assertFails(noVersion, { version: '0.12.0' }, /packages\/shared\/package\.json 沒有 "version" 欄位/);
  const broken = makeRepo();
  writeFileSync(join(broken, 'apps/server/package.json'), '{ "version": ', 'utf8');
  assertFails(broken, { version: '0.12.0' }, /apps\/server\/package\.json 不是合法 JSON/);
});

test('maxReleaseTag: only vX.Y.Z counts, compared by semver', () => {
  assert.equal(maxReleaseTag(TAGS), 'v0.11.1');
  assert.equal(maxReleaseTag(['v0.9.0', 'v0.10.0']), 'v0.10.0');
  assert.equal(maxReleaseTag(['v2.0.0-rc1', 'latest']), null);
});

test('localDate: uses the year/month/day in the local time zone', () => {
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('parseArgs: version and --date', () => {
  assert.deepEqual(parseArgs(['node', 's', '0.12.0']), { version: '0.12.0', date: undefined });
  assert.deepEqual(parseArgs(['node', 's', '--date', '2026-10-20', '0.12.0']), { version: '0.12.0', date: '2026-10-20' });
  assert.throws(() => parseArgs(['node', 's']), /用法/);
  assert.throws(() => parseArgs(['node', 's', '0.12.0', '--date']), /--date 後面要接日期/);
  assert.throws(() => parseArgs(['node', 's', '--date', '--x', '0.12.0']), /--date 後面要接日期/);
  assert.throws(() => parseArgs(['node', 's', '0.12.0', '0.13.0']), /多餘的參數/);
});
