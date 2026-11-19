#!/usr/bin/env node
// Reads only the Markdown this repo uses. Not recognised, so add support before using them:
// - reference-style links (`[text][ref]`, `[ref]: url`), footnotes, and titles after a destination
// - parentheses inside a link destination; percent-encoding or `?query` in a path
// - code spans and HTML tags that continue onto the next line (each line is read on its own)
// - indented code blocks, `~~~` fences, fences of four or more backticks, fences inside comments
// - setext headings, indented headings, headings inside blockquotes, closing `#`s on a heading
// - heading markup other than code spans (links, images, `_emphasis_`, HTML, entities such as
//   `&nbsp;`, autolinks) and `\p{No}` characters, where the slug can differ from GitHub's
// - a heading whose slug equals an earlier heading's numbered slug (`a`, `a-1`, `a`)
// - `id`/`name` anchors in HTML, and anchors written in a different case from the heading
// - in HTML: single-quoted or unquoted `src`/`href`, spaces around `=`, `>` inside an earlier
//   attribute, `srcset`

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FENCE = /^\s*```/;
const ATX_HEADING = /^#{1,6}[ \t]+(.*?)[ \t]*$/;
const CODE_SPAN = /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;
const INLINE_LINK = /\]\((<[^>]*>|[^()\s]+)\)/g;
const HTML_TAG = /<[a-z][a-z0-9-]*\s[^<>]*>/gi;
const HTML_LINK_ATTRIBUTE = /\s(?:href|src)="([^"]*)"/gi;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// GitHub's heading slug: lowercase, drop every character that isn't a letter, number, mark,
// connector punctuation (`_`), space or `-`, then turn each space into `-`.
export function githubSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

const blankOut = (match) => match.replace(/[^\n]/g, ' ');

// Blanks fenced code and HTML comments instead of dropping them, so line numbers stay right.
function visibleLines(text) {
  let inFence = false;
  let inComment = false;

  return text.split(/\r?\n/).map((raw) => {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      return '';
    }
    if (inFence) return '';

    let line = raw;
    if (inComment) {
      const end = line.indexOf('-->');
      if (end === -1) return '';
      line = ' '.repeat(end + 3) + line.slice(end + 3);
      inComment = false;
    }

    // `<!--` inside a code span is text, not the start of a comment.
    const masked = line.replace(CODE_SPAN, blankOut);
    let from = 0;
    let start;
    while ((start = masked.indexOf('<!--', from)) !== -1) {
      const end = masked.indexOf('-->', start + 4);
      if (end === -1) {
        inComment = true;
        return line.slice(0, start);
      }
      line = line.slice(0, start) + ' '.repeat(end + 3 - start) + line.slice(end + 3);
      from = end + 3;
    }

    return line;
  });
}

export function collectAnchors(text) {
  const anchors = new Set();
  const seen = new Map();

  for (const line of visibleLines(text)) {
    const heading = ATX_HEADING.exec(line);
    if (!heading) continue;

    const base = githubSlug(heading[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }

  return anchors;
}

export function extractLinks(text) {
  const links = [];

  visibleLines(text).forEach((visible, index) => {
    const line = visible.replace(CODE_SPAN, blankOut);

    for (const match of line.matchAll(INLINE_LINK)) {
      links.push({ destination: match[1].replace(/^<(.*)>$/, '$1'), line: index + 1 });
    }
    for (const tag of line.matchAll(HTML_TAG)) {
      for (const attribute of tag[0].matchAll(HTML_LINK_ATTRIBUTE)) links.push({ destination: attribute[1], line: index + 1 });
    }
  });

  return links;
}

export function isExternal(destination) {
  return SCHEME.test(destination) || destination.startsWith('//');
}

/**
 * @param {object} repo
 * @param {string[]} repo.markdownFiles  repo-relative paths (with `/`) of the files to check
 * @param {(file: string) => boolean} repo.isFile  whether a repo-relative path is a file in the repo
 * @param {(dir: string) => boolean} repo.isDirectory  whether a repo-relative path is a directory in the repo
 * @param {(file: string) => string} repo.readFile  contents of a repo-relative Markdown file
 * @returns {{ file: string, line: number, destination: string, reason: string }[]}
 */
export function findBrokenLinks({ markdownFiles, isFile, isDirectory, readFile }) {
  const anchorCache = new Map();
  const anchorsOf = (file) => {
    if (!anchorCache.has(file)) anchorCache.set(file, collectAnchors(readFile(file)));
    return anchorCache.get(file);
  };
  const broken = [];

  for (const file of markdownFiles) {
    for (const { destination, line } of extractLinks(readFile(file))) {
      if (isExternal(destination)) continue;

      const hashAt = destination.indexOf('#');
      const linkPath = hashAt === -1 ? destination : destination.slice(0, hashAt);
      const anchor = hashAt === -1 ? null : destination.slice(hashAt + 1);

      let target = file;
      if (linkPath !== '') {
        // GitHub resolves a path starting with `/` from the repository root.
        const joined = linkPath.startsWith('/') ? linkPath.slice(1) : path.posix.join(path.posix.dirname(file), linkPath);
        target = path.posix.normalize(joined).replace(/\/$/, '');

        if (!isFile(target) && !isDirectory(target)) {
          broken.push({ file, line, destination, reason: 'no such file or directory' });
          continue;
        }
      }

      if (anchor === null || !target.endsWith('.md')) continue;

      if (!anchorsOf(target).has(anchor)) {
        broken.push({ file, line, destination, reason: `no heading "${anchor}" in ${target}` });
      }
    }
  }

  return broken;
}

// The repo's files as git sees them: tracked, plus untracked files that aren't ignored, so a
// new page is checked before it is committed. Files deleted from the working tree are left out.
function listRepoFiles(root) {
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  return [...new Set(output.split('\0').filter(Boolean))].filter((file) => existsSync(path.join(root, file)));
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = listRepoFiles(root);
  const fileSet = new Set(files);
  const dirSet = new Set(['.']);

  for (const file of files) {
    for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) dirSet.add(dir);
  }

  const markdownFiles = files.filter((file) => file.endsWith('.md')).sort();
  const broken = findBrokenLinks({
    markdownFiles,
    isFile: (file) => fileSet.has(file),
    isDirectory: (dir) => dirSet.has(dir),
    readFile: (file) => readFileSync(path.join(root, file), 'utf8'),
  });

  for (const { file, line, destination, reason } of broken) console.error(`${file}:${line}: ${destination} — ${reason}`);

  if (broken.length > 0) {
    console.error(`\n${broken.length} broken link(s) in ${markdownFiles.length} Markdown files.`);
    process.exit(1);
  }

  console.log(`All relative links and anchors in ${markdownFiles.length} Markdown files resolve.`);
}

// argv[1] is undefined under `node -e`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
