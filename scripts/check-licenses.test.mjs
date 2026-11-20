// node:test; nothing runs pnpm - every case is fed hand-made mock data.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  analyzeWorkspaceDependencyTree,
  assertLicensesShape,
  assertWorkspacePackagesShape,
  countLicensedPackages,
  findGplViolations,
  findUnknownLicenseViolations,
} from './check-licenses.mjs';

test('findGplViolations: matches GPL and LGPL, does not hit other licences', () => {
  const violations = findGplViolations({
    'LGPL-3.0': [{ name: 'foo-lib' }],
    'GPL-2.0-only': [{ name: 'baz' }],
    MIT: [{ name: 'bar' }],
  });

  assert.deepEqual(violations.sort(), ['baz (GPL-2.0-only)', 'foo-lib (LGPL-3.0)'].sort());
});

test('findGplViolations: returns an empty array when all licences are permissive OSS', () => {
  const violations = findGplViolations({ MIT: [{ name: 'ok' }], 'Apache-2.0': [{ name: 'also-ok' }] });
  assert.deepEqual(violations, []);
});

test('findUnknownLicenseViolations: matches Unknown licences', () => {
  const violations = findUnknownLicenseViolations({
    Unknown: [{ name: 'mystery-pkg' }],
    MIT: [{ name: 'ok' }],
  });
  assert.deepEqual(violations, ['mystery-pkg']);
});

test('findUnknownLicenseViolations: matches the "unknown" key case-insensitively', () => {
  const violations = findUnknownLicenseViolations({ unknown: [{ name: 'weird-case-pkg' }] });
  assert.deepEqual(violations, ['weird-case-pkg']);
});

test('countLicensedPackages: sums across licence buckets', () => {
  const total = countLicensedPackages({ MIT: [{ name: 'a' }, { name: 'b' }], ISC: [{ name: 'c' }] });
  assert.equal(total, 3);
});

test('analyzeWorkspaceDependencyTree: top-level dependencies matching @blocknote/xl-', () => {
  const { blocknoteXlViolations } = analyzeWorkspaceDependencyTree([
    { name: 'app', dependencies: { '@blocknote/xl-pdf-exporter': { version: '1.0.0' } } },
  ]);
  assert.deepEqual(blocknoteXlViolations, ['@blocknote/xl-pdf-exporter']);
});

test('analyzeWorkspaceDependencyTree: nested dependencies matching @blocknote/xl-', () => {
  const { blocknoteXlViolations } = analyzeWorkspaceDependencyTree([
    {
      name: 'app',
      dependencies: {
        foo: { dependencies: { '@blocknote/xl-docx-exporter': { version: '1.0.0' } } },
      },
    },
  ]);
  assert.deepEqual(blocknoteXlViolations, ['@blocknote/xl-docx-exporter']);
});

test('analyzeWorkspaceDependencyTree: top-level and nested devDependencies both match @blocknote/xl-', () => {
  const { blocknoteXlViolations } = analyzeWorkspaceDependencyTree([
    {
      name: 'app',
      devDependencies: {
        '@blocknote/xl-docx-exporter': {
          version: '1.0.0',
          dependencies: { '@blocknote/xl-nested-thing': { version: '1.0.0' } },
        },
      },
    },
  ]);
  assert.deepEqual(
    blocknoteXlViolations.sort(),
    ['@blocknote/xl-docx-exporter', '@blocknote/xl-nested-thing'].sort(),
  );
});

test('analyzeWorkspaceDependencyTree: top-level and nested optionalDependencies both match @blocknote/xl-', () => {
  const { blocknoteXlViolations } = analyzeWorkspaceDependencyTree([
    {
      name: 'app',
      optionalDependencies: {
        '@blocknote/xl-pdf-exporter': {
          version: '1.0.0',
          optionalDependencies: { '@blocknote/xl-deep-optional': { version: '1.0.0' } },
        },
      },
    },
  ]);
  assert.deepEqual(
    blocknoteXlViolations.sort(),
    ['@blocknote/xl-pdf-exporter', '@blocknote/xl-deep-optional'].sort(),
  );
});

test('analyzeWorkspaceDependencyTree: @blocknote/core (not the xl- prefix) is not caught by mistake', () => {
  const { blocknoteXlViolations } = analyzeWorkspaceDependencyTree([
    { name: 'app', dependencies: { '@blocknote/core': { version: '1.0.0' } } },
  ]);
  assert.deepEqual(blocknoteXlViolations, []);
});

test('analyzeWorkspaceDependencyTree: totalDependencyNodes counts the whole tree deduplicated', () => {
  const { totalDependencyNodes } = analyzeWorkspaceDependencyTree([
    {
      name: 'app',
      dependencies: {
        foo: { dependencies: { shared: { version: '1.0.0' } } },
        bar: { optionalDependencies: { shared: { version: '1.0.0' } } },
      },
    },
  ]);
  // foo, bar, shared (deduplicated even though shared appears twice)
  assert.equal(totalDependencyNodes, 3);
});

test('assertLicensesShape: a valid shape does not throw', () => {
  assert.doesNotThrow(() => assertLicensesShape({ MIT: [{ name: 'ok' }] }));
});

test('assertLicensesShape: a non-plain object (e.g. an array) throws', () => {
  assert.throws(() => assertLicensesShape([{ name: 'ok' }]));
});

test('assertLicensesShape: null throws', () => {
  assert.throws(() => assertLicensesShape(null));
});

test('assertLicensesShape: an empty object throws', () => {
  assert.throws(() => assertLicensesShape({}));
});

test('assertLicensesShape: a value that is not an array throws', () => {
  assert.throws(() => assertLicensesShape({ MIT: { name: 'not-an-array' } }));
});

test('assertWorkspacePackagesShape: a valid shape does not throw', () => {
  assert.doesNotThrow(() => assertWorkspacePackagesShape([{ name: 'app' }]));
});

test('assertWorkspacePackagesShape: a non-array throws', () => {
  assert.throws(() => assertWorkspacePackagesShape({ name: 'app' }));
});

test('assertWorkspacePackagesShape: an empty array throws', () => {
  assert.throws(() => assertWorkspacePackagesShape([]));
});

test('assertWorkspacePackagesShape: an element without name throws', () => {
  assert.throws(() => assertWorkspacePackagesShape([{ dependencies: {} }]));
});
