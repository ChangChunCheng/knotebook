#!/usr/bin/env node
// Fail closed: an unexpected pnpm output shape or a suspiciously small scan throws instead of passing.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const IS_WINDOWS = process.platform === 'win32';

// Floor against silent degradation (--depth ignored, truncated output, empty workspace); deliberately low.
const MIN_EXPECTED_DEPENDENCY_COUNT = 20;

// Exempting a GPL-family package needs an inline reason and a human review, not just the name.
/** @type {string[]} */
const EXEMPTIONS = [];

// Same rule as EXEMPTIONS: add the name with an inline reason.
/** @type {string[]} */
const UNKNOWN_ACKNOWLEDGED = [
  // khroma (a mermaid dependency) has no license field in package.json, but ships a full MIT license file: a metadata gap, not an unknown license.
  // Re-check the license file when a mermaid upgrade changes khroma's version.
  'khroma',
];

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {unknown}
 */
export function runJson(command, args) {
  // On Windows pnpm is a .cmd shim that needs shell: true; one command string avoids Node's deprecation warning for shell: true with an args array.
  // The arguments are constants, so no injection risk.
  const output = execFileSync(IS_WINDOWS ? `${command} ${args.join(' ')}` : command, IS_WINDOWS ? [] : args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
    shell: IS_WINDOWS,
  });
  return JSON.parse(output);
}

/**
 * @param {unknown} value
 * @returns {asserts value is Record<string, Array<{ name: string; license?: string }>>}
 */
export function assertLicensesShape(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      'check-licenses: `pnpm licenses list --json` 輸出形狀不符預期（應為非空 plain object，key 為授權名稱）。',
    );
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new Error('check-licenses: `pnpm licenses list --json` 輸出是空物件，疑似掃描退化，拒絕放行。');
  }

  for (const [licenseName, packages] of entries) {
    if (!Array.isArray(packages)) {
      throw new Error(
        `check-licenses: \`pnpm licenses list --json\` 輸出形狀不符預期（key "${licenseName}" 的 value 不是陣列）。`,
      );
    }
  }
}

/**
 * @param {unknown} value
 * @returns {asserts value is Array<{ name: string; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown> }>}
 */
export function assertWorkspacePackagesShape(value) {
  if (!Array.isArray(value)) {
    throw new Error(
      'check-licenses: `pnpm ls -r --depth Infinity --json` 輸出形狀不符預期（應為陣列，一個 workspace package 一個元素）。',
    );
  }

  if (value.length === 0) {
    throw new Error('check-licenses: `pnpm ls -r --depth Infinity --json` 輸出是空陣列，疑似 workspace 讀空，拒絕放行。');
  }

  for (const [index, pkg] of value.entries()) {
    if (typeof pkg !== 'object' || pkg === null || typeof pkg.name !== 'string' || pkg.name.length === 0) {
      throw new Error(
        `check-licenses: \`pnpm ls -r --depth Infinity --json\` 輸出形狀不符預期（索引 ${index} 的元素缺少 name）。`,
      );
    }
  }
}

/**
 * @param {Record<string, Array<{ name: string; license?: string }>>} licensesByName
 */
export function findGplViolations(licensesByName) {
  /** @type {string[]} */
  const violations = [];

  for (const [licenseName, packages] of Object.entries(licensesByName)) {
    if (!/GPL/i.test(licenseName)) continue;

    for (const pkg of packages) {
      if (EXEMPTIONS.includes(pkg.name)) continue;
      violations.push(`${pkg.name} (${licenseName})`);
    }
  }

  return violations;
}

/**
 * @param {Record<string, Array<{ name: string; license?: string }>>} licensesByName
 */
export function findUnknownLicenseViolations(licensesByName) {
  /** @type {string[]} */
  const violations = [];

  for (const [licenseName, packages] of Object.entries(licensesByName)) {
    if (licenseName.trim().toLowerCase() !== 'unknown') continue;

    for (const pkg of packages) {
      if (UNKNOWN_ACKNOWLEDGED.includes(pkg.name)) continue;
      violations.push(pkg.name);
    }
  }

  return violations;
}

/**
 * @param {Record<string, Array<{ name: string; license?: string }>>} licensesByName
 */
export function countLicensedPackages(licensesByName) {
  return Object.values(licensesByName).reduce((sum, packages) => sum + packages.length, 0);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown> }>}
 */
function isDependencyMap(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * @param {Record<string, unknown>} depMap
 * @param {Set<string>} blocknoteXlFound
 * @param {Set<string>} allNodeNames
 */
function walkDependencyTree(depMap, blocknoteXlFound, allNodeNames) {
  for (const [depName, depInfo] of Object.entries(depMap)) {
    allNodeNames.add(depName);

    if (depName.startsWith('@blocknote/xl-')) {
      blocknoteXlFound.add(depName);
    }

    if (isDependencyMap(depInfo)) {
      const nested = depInfo;
      if (nested.dependencies) walkDependencyTree(nested.dependencies, blocknoteXlFound, allNodeNames);
      if (nested.devDependencies) walkDependencyTree(nested.devDependencies, blocknoteXlFound, allNodeNames);
      if (nested.optionalDependencies) walkDependencyTree(nested.optionalDependencies, blocknoteXlFound, allNodeNames);
    }
  }
}

/**
 * @param {Array<{ name?: string; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown> }>} packages
 */
export function analyzeWorkspaceDependencyTree(packages) {
  const blocknoteXlFound = new Set();
  const allNodeNames = new Set();

  for (const pkg of packages) {
    if (pkg.dependencies) walkDependencyTree(pkg.dependencies, blocknoteXlFound, allNodeNames);
    if (pkg.devDependencies) walkDependencyTree(pkg.devDependencies, blocknoteXlFound, allNodeNames);
    if (pkg.optionalDependencies) walkDependencyTree(pkg.optionalDependencies, blocknoteXlFound, allNodeNames);
  }

  return {
    blocknoteXlViolations: [...blocknoteXlFound],
    totalDependencyNodes: allNodeNames.size,
  };
}

export function main() {
  let hasViolations = false;

  const licensesByNameRaw = runJson('pnpm', ['--loglevel', 'error', 'licenses', 'list', '--json']);
  assertLicensesShape(licensesByNameRaw);
  const licensesByName = licensesByNameRaw;

  const totalLicensedPackages = countLicensedPackages(licensesByName);
  if (totalLicensedPackages < MIN_EXPECTED_DEPENDENCY_COUNT) {
    throw new Error(
      `check-licenses: \`pnpm licenses list --json\` 只掃到 ${totalLicensedPackages} 個套件條目，` +
        `低於下限 ${MIN_EXPECTED_DEPENDENCY_COUNT}，疑似掃描退化，拒絕放行。`,
    );
  }

  const gplViolations = findGplViolations(licensesByName);
  if (gplViolations.length > 0) {
    hasViolations = true;
    console.error('GPL 系列授權（含 LGPL）依賴被禁止使用：');
    for (const violation of gplViolations) {
      console.error(`  - ${violation}`);
    }
    console.error(
      '若確認可豁免，須於 scripts/check-licenses.mjs 的 EXEMPTIONS 附上套件名稱與理由，並經人工審查。',
    );
  }

  const unknownViolations = findUnknownLicenseViolations(licensesByName);
  if (unknownViolations.length > 0) {
    hasViolations = true;
    console.error('授權無法辨識（Unknown）的依賴被禁止使用：');
    for (const pkgName of unknownViolations) {
      console.error(`  - ${pkgName}`);
    }
    console.error(
      '若確認可接受，須於 scripts/check-licenses.mjs 的 UNKNOWN_ACKNOWLEDGED 附上套件名稱與理由，並經人工審查。',
    );
  }

  const workspacePackagesRaw = runJson('pnpm', ['--loglevel', 'error', 'ls', '-r', '--depth', 'Infinity', '--json']);
  assertWorkspacePackagesShape(workspacePackagesRaw);
  const workspacePackages = workspacePackagesRaw;

  const { blocknoteXlViolations, totalDependencyNodes } = analyzeWorkspaceDependencyTree(workspacePackages);
  if (totalDependencyNodes < MIN_EXPECTED_DEPENDENCY_COUNT) {
    throw new Error(
      `check-licenses: \`pnpm ls -r --depth Infinity --json\` 只掃到 ${totalDependencyNodes} 個依賴節點，` +
        `低於下限 ${MIN_EXPECTED_DEPENDENCY_COUNT}，疑似 --depth 沒吃到或掃描退化，拒絕放行。`,
    );
  }

  if (blocknoteXlViolations.length > 0) {
    hasViolations = true;
    console.error('禁止的 @blocknote/xl- 前綴（商業版）依賴：');
    for (const violation of blocknoteXlViolations) {
      console.error(`  - ${violation}`);
    }
  }

  if (hasViolations) {
    process.exit(1);
  }

  console.log(
    `check-licenses: OK（${totalLicensedPackages} 個授權條目、${totalDependencyNodes} 個依賴節點；` +
      '無 GPL/LGPL、無 Unknown 授權、無 @blocknote/xl- 依賴）',
  );
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
