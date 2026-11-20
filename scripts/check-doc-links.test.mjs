import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectAnchors, extractLinks, findBrokenLinks, githubSlug, isExternal } from './check-doc-links.mjs';

function repo(files, directories = []) {
  return {
    markdownFiles: Object.keys(files).filter((file) => file.endsWith('.md')),
    isFile: (file) => Object.hasOwn(files, file),
    isDirectory: (dir) => directories.includes(dir),
    readFile: (file) => files[file],
  };
}

const destinations = (text) => extractLinks(text).map(({ destination }) => destination);

test('githubSlug: lowercases, drops punctuation except - and _, turns spaces into -', () => {
  assert.equal(githubSlug('Sending notes back as files (MCP bulk transfer)'), 'sending-notes-back-as-files-mcp-bulk-transfer');
  assert.equal(githubSlug('[0.17.1] - 2026-11-18'), '0171---2026-11-18');
  assert.equal(githubSlug('snake_case & more!'), 'snake_case--more');
  assert.equal(githubSlug('筆記 Notes'), '筆記-notes');
  assert.equal(githubSlug('Café menu'), 'café-menu');
});

test('collectAnchors: slugs headings, keeping code span text literally', () => {
  const anchors = collectAnchors('# Title\n\n## The `edit_note` tool\n\n## `GET /api/notes/<id>`\n');

  assert.deepEqual([...anchors].sort(), ['get-apinotesid', 'the-edit_note-tool', 'title']);
});

test('collectAnchors: repeated headings get -1, -2 suffixes', () => {
  assert.deepEqual([...collectAnchors('## Added\n\n## Added\n\n## Added\n')], ['added', 'added-1', 'added-2']);
});

test('collectAnchors: reads CRLF files', () => {
  assert.deepEqual([...collectAnchors('# One\r\n\r\n## Two\r\n')], ['one', 'two']);
});

test('collectAnchors: ignores headings in fenced code (including indented fences) and HTML comments', () => {
  const text = ['```sh', '# shell comment', '```', '1. Step', '     ```sh', '# indented', '     ```', '<!--', '## Commented out', '-->', '## Real'].join('\n');

  assert.deepEqual([...collectAnchors(text)], ['real']);
});

test('extractLinks: finds inline links, images and <…> destinations with line numbers', () => {
  assert.deepEqual(extractLinks('See [a](./a.md) and ![pic](img/p.png).\n\nMore [b](<./with space.md#x>).\n'), [
    { destination: './a.md', line: 1 },
    { destination: 'img/p.png', line: 1 },
    { destination: './with space.md#x', line: 3 },
  ]);
});

test('extractLinks: skips code spans and fenced code', () => {
  const text = ['Use `[x](./nope.md)` here, or ``[y](./nope2.md)``.', '- item', '  ```md', '  [z](./nope3.md)', '  ```', 'Real [link](./yes.md).'].join('\n');

  assert.deepEqual(extractLinks(text), [{ destination: './yes.md', line: 6 }]);
});

test('extractLinks: skips HTML comments on one line and across lines', () => {
  const text = [
    'a <!-- [w](./nope1.md) --> [x](./yes1.md)',
    '[y](./yes2.md) <!-- [gone](./nope2.md)',
    '[gone](./nope3.md)',
    '',
    '[gone](./nope4.md) --> [z](./yes3.md)',
    '[after](./yes4.md)',
  ].join('\n');

  assert.deepEqual(destinations(text), ['./yes1.md', './yes2.md', './yes3.md', './yes4.md']);
});

test('extractLinks: `<!--` and `-->` in code spans do not hide the link between them', () => {
  assert.deepEqual(destinations('Write `<!--` then [link](./checked.md) then `-->`.'), ['./checked.md']);
});

test('extractLinks: picks up src and href in HTML tags, but not in code spans', () => {
  const text = '<p align="center"><img alt="x" src="docs/a.png" width="640"></p>\n<a href="./b.md#part">b</a> `<img src="nope.png">`\n';

  assert.deepEqual(extractLinks(text), [
    { destination: 'docs/a.png', line: 1 },
    { destination: './b.md#part', line: 2 },
  ]);
});

test('isExternal: URLs with a scheme or // are external', () => {
  assert.ok(isExternal('https://example.com'));
  assert.ok(isExternal('mailto:a@example.com'));
  assert.ok(isExternal('//example.com/x'));
  assert.ok(!isExternal('./docs/x.md'));
  assert.ok(!isExternal('#anchor'));
});

test('findBrokenLinks: a clean repo has no broken links', () => {
  const broken = findBrokenLinks(
    repo(
      {
        'README.md':
          '[Docs](docs/guide.md#install) [Self](#readme) [Dir](docs/) [Root](/LICENSE) [Ext](https://x.y/z.md#q)\n\n# Readme\n\n' +
          '<img src="/docs/img/a.png"> <a href="#readme">top</a>\n',
        'docs/guide.md': '# Guide\n\n## Install\n\n[Back](../README.md#readme) [Img](./img/a.png) [Page](../README.md) [Root](/LICENSE) <img src="/docs/img/a.png">\n',
        'docs/img/a.png': '',
        LICENSE: '',
      },
      ['docs', 'docs/img'],
    ),
  );

  assert.deepEqual(broken, []);
});

test('findBrokenLinks: reports missing files and anchors, in Markdown links and HTML', () => {
  const broken = findBrokenLinks(
    repo({
      'README.md': '# Readme\n\n[a](docs/missing.md)\n[b](docs/guide.md#nowhere)\n[c](#readme-1)\n<img src="docs/missing.png">\n<img src="/nope.png">\n',
      'docs/guide.md': '# Guide\n',
    }),
  );

  assert.deepEqual(
    broken.map(({ line, destination }) => [line, destination]),
    [
      [3, 'docs/missing.md'],
      [4, 'docs/guide.md#nowhere'],
      [5, '#readme-1'],
      [6, 'docs/missing.png'],
      [7, '/nope.png'],
    ],
  );
  assert.match(broken[1].reason, /nowhere/);
});

test('findBrokenLinks: does not check anchors on links to files that are not Markdown', () => {
  assert.deepEqual(findBrokenLinks(repo({ 'README.md': '[code](src/a.ts#L10)\n', 'src/a.ts': '' })), []);
});
