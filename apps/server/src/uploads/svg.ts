/**
 * Strict, single-pass XML 1.0 well-formedness validator for SVG uploads (#389).
 *
 * Intentionally avoids `jsdom` (which REST-only apps don't load and which is quadratic on large
 * element lists) and never expands custom entities (immune to Billion Laughs / XXE). It does not
 * strip `<script>`, event handlers or `<foreignObject>`: uploaded SVGs are neutralized at render
 * time by `<img>` and on direct navigation by `Content-Security-Policy: ...; sandbox`.
 */

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const PREDEFINED_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);

// XML 1.0 §2.2 Char forbids C0 controls other than TAB/LF/CR, plus U+FFFE and U+FFFF.
const ILLEGAL_XML_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/;

// XML 1.0 (5th ed.) NameStartChar / NameChar.
const NAME_START_RE = /^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/u;
const NAME_CHAR_RE = /^[:A-Z_a-z\-.0-9\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0300-\u036F\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u203F-\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/u;

function isXmlSpace(ch: number): boolean {
  return ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d;
}

function isValidXmlCodePoint(cp: number): boolean {
  return (
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0d ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/** True when `bytes` is valid UTF-8 well-formed XML 1.0 whose root element is `<svg>`. */
export function isValidSvgXml(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;

  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    return false;
  }
  if (text.length === 0 || ILLEGAL_XML_CHAR_RE.test(text)) return false;

  const len = text.length;
  let i = 0;

  // Fast reject for inputs that cannot possibly start with XML markup.
  const firstNonSpace = skipSpaceFrom(text, 0);
  if (firstNonSpace >= len || text.charCodeAt(firstNonSpace) !== 0x3c /* '<' */) return false;

  const declaredEntities = new Set<string>();

  function skipSpace(): void {
    while (i < len && isXmlSpace(text.charCodeAt(i))) i++;
  }

  function readName(): string | null {
    if (i >= len) return null;
    const start = i;
    const first = text.codePointAt(i)!;
    // Fast ASCII path covers virtually all SVG element and attribute names.
    if (
      (first >= 0x41 && first <= 0x5a) ||
      (first >= 0x61 && first <= 0x7a) ||
      first === 0x5f ||
      first === 0x3a
    ) {
      i++;
    } else if (first >= 0x10000 && first <= 0xeffff) {
      i += 2;
    } else if (NAME_START_RE.test(text.slice(i, i + 2))) {
      i++;
    } else {
      return null;
    }

    while (i < len) {
      const ch = text.charCodeAt(i);
      if (
        (ch >= 0x41 && ch <= 0x5a) ||
        (ch >= 0x61 && ch <= 0x7a) ||
        (ch >= 0x30 && ch <= 0x39) ||
        ch === 0x5f ||
        ch === 0x2d ||
        ch === 0x2e ||
        ch === 0x3a
      ) {
        i++;
      } else if (ch < 0x80) {
        break;
      } else {
        const cp = text.codePointAt(i)!;
        if (cp >= 0x10000 && cp <= 0xeffff) {
          i += 2;
        } else if (NAME_CHAR_RE.test(text.slice(i, i + 2))) {
          i++;
        } else {
          break;
        }
      }
    }
    return text.slice(start, i);
  }

  function parseComment(): boolean {
    // Caller verified `<!--` at `i`.
    i += 4;
    const end = text.indexOf("--", i);
    if (end === -1 || end + 2 >= len || text.charCodeAt(end + 2) !== 0x3e /* '>' */) return false;
    i = end + 3;
    return true;
  }

  function parsePI(allowXmlDecl: boolean): boolean {
    // Caller verified `<?` at `i`.
    i += 2;
    const target = readName();
    if (target === null) return false;
    const isXmlTarget = target.toLowerCase() === "xml";
    if (isXmlTarget) {
      if (!allowXmlDecl || target !== "xml") return false;
    }
    if (i + 1 < len && text.charCodeAt(i) === 0x3f /* '?' */ && text.charCodeAt(i + 1) === 0x3e /* '>' */) {
      if (isXmlTarget) return false; // `<?xml?>` without version is not a valid XMLDecl
      i += 2;
      return true;
    }
    if (i >= len || !isXmlSpace(text.charCodeAt(i))) return false;
    const end = text.indexOf("?>", i);
    if (end === -1) return false;
    if (isXmlTarget) {
      const body = text.slice(i, end).trim();
      if (!/^version\s*=\s*(?:"1\.[0-9]+"|'1\.[0-9]+')(?:\s+encoding\s*=\s*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?$/.test(body)) {
        return false;
      }
    }
    i = end + 2;
    return true;
  }

  function parseReference(): boolean {
    // Caller verified `&` at `i`.
    i++;
    if (i >= len) return false;
    if (text.charCodeAt(i) === 0x23 /* '#' */) {
      i++;
      const hex = i < len && text.charCodeAt(i) === 0x78 /* 'x' */;
      if (hex) i++;
      const start = i;
      while (i < len && text.charCodeAt(i) !== 0x3b /* ';' */) i++;
      if (i >= len || i === start) return false;
      const digits = text.slice(start, i);
      if (hex ? !/^[0-9A-Fa-f]+$/.test(digits) : !/^[0-9]+$/.test(digits)) return false;
      const cp = Number.parseInt(digits, hex ? 16 : 10);
      if (!isValidXmlCodePoint(cp)) return false;
      i++; // ';'
      return true;
    }
    const name = readName();
    if (name === null || i >= len || text.charCodeAt(i) !== 0x3b /* ';' */) return false;
    if (!PREDEFINED_ENTITIES.has(name) && !declaredEntities.has(name)) return false;
    i++; // ';'
    return true;
  }

  function parseQuotedLiteral(): boolean {
    if (i >= len) return false;
    const quote = text.charCodeAt(i);
    if (quote !== 0x22 /* '"' */ && quote !== 0x27 /* "'" */) return false;
    const end = text.indexOf(String.fromCharCode(quote), i + 1);
    if (end === -1) return false;
    i = end + 1;
    return true;
  }

  function parseDoctype(): boolean {
    // Caller verified `<!DOCTYPE` at `i`.
    i += 9;
    if (i >= len || !isXmlSpace(text.charCodeAt(i))) return false;
    skipSpace();
    if (readName() === null) return false;
    skipSpace();
    if (text.startsWith("SYSTEM", i)) {
      i += 6;
      if (i >= len || !isXmlSpace(text.charCodeAt(i))) return false;
      skipSpace();
      if (!parseQuotedLiteral()) return false;
      skipSpace();
    } else if (text.startsWith("PUBLIC", i)) {
      i += 6;
      if (i >= len || !isXmlSpace(text.charCodeAt(i))) return false;
      skipSpace();
      if (!parseQuotedLiteral()) return false;
      if (i >= len || !isXmlSpace(text.charCodeAt(i))) return false;
      skipSpace();
      if (!parseQuotedLiteral()) return false;
      skipSpace();
    }

    if (i < len && text.charCodeAt(i) === 0x5b /* '[' */) {
      i++;
      while (i < len) {
        skipSpace();
        if (i >= len) return false;
        const ch = text.charCodeAt(i);
        if (ch === 0x5d /* ']' */) {
          i++;
          skipSpace();
          break;
        }
        if (text.startsWith("<!--", i)) {
          if (!parseComment()) return false;
        } else if (text.startsWith("<?", i)) {
          if (!parsePI(false)) return false;
        } else if (text.startsWith("<!", i)) {
          // Record `<!ENTITY name ...>` names so references inside the document validate without expanding them.
          const isEntity = text.startsWith("<!ENTITY", i) && i + 8 < len && isXmlSpace(text.charCodeAt(i + 8));
          i += 2;
          if (isEntity) {
            i += 6;
            skipSpace();
            if (i < len && text.charCodeAt(i) !== 0x25 /* '%' */) {
              const entityName = readName();
              if (entityName !== null) declaredEntities.add(entityName);
            }
          }
          let closed = false;
          while (i < len) {
            const c = text.charCodeAt(i);
            if (c === 0x22 || c === 0x27) {
              if (!parseQuotedLiteral()) return false;
            } else if (c === 0x3e /* '>' */) {
              i++;
              closed = true;
              break;
            } else {
              i++;
            }
          }
          if (!closed) return false;
        } else if (ch === 0x25 /* '%' */) {
          i++;
          if (readName() === null || i >= len || text.charCodeAt(i) !== 0x3b) return false;
          i++;
        } else {
          return false;
        }
      }
    }

    if (i >= len || text.charCodeAt(i) !== 0x3e /* '>' */) return false;
    i++;
    return true;
  }

  function parseAttributeValue(): string | null {
    if (i >= len) return null;
    const quote = text.charCodeAt(i);
    if (quote !== 0x22 /* '"' */ && quote !== 0x27 /* "'" */) return null;
    i++;
    const valueStart = i;
    while (i < len) {
      const ch = text.charCodeAt(i);
      if (ch === quote) {
        const value = text.slice(valueStart, i);
        i++;
        return value;
      }
      if (ch === 0x3c /* '<' */) return null;
      if (ch === 0x26 /* '&' */) {
        if (!parseReference()) return null;
        continue;
      }
      i++;
    }
    return null;
  }

  // 1. Optional XML declaration at offset 0.
  if (text.startsWith("<?xml", 0)) {
    if (!parsePI(true)) return false;
  }

  // 2. Prolog: whitespace, comments, PIs, and at most one DOCTYPE.
  let sawDoctype = false;
  while (i < len) {
    skipSpace();
    if (i >= len) return false;
    if (text.charCodeAt(i) !== 0x3c /* '<' */) return false;
    if (text.startsWith("<!--", i)) {
      if (!parseComment()) return false;
    } else if (text.startsWith("<?", i)) {
      if (!parsePI(false)) return false;
    } else if (text.startsWith("<!DOCTYPE", i)) {
      if (sawDoctype || !parseDoctype()) return false;
      sawDoctype = true;
    } else {
      break;
    }
  }

  // 3. Root element + element tree.
  const stack: string[] = [];
  let parsedRoot = false;

  while (i < len) {
    if (!parsedRoot) {
      if (text.charCodeAt(i) !== 0x3c /* '<' */) return false;
      i++;
      const tagName = readName();
      if (tagName === null) return false;

      const attrs = new Map<string, string>();
      let selfClosing = false;
      while (true) {
        const beforeSpace = i;
        skipSpace();
        if (i >= len) return false;
        const ch = text.charCodeAt(i);
        if (ch === 0x3e /* '>' */) {
          i++;
          break;
        }
        if (ch === 0x2f /* '/' */) {
          if (i + 1 >= len || text.charCodeAt(i + 1) !== 0x3e /* '>' */) return false;
          i += 2;
          selfClosing = true;
          break;
        }
        if (i === beforeSpace) return false; // whitespace required between tag/attrs
        const attrName = readName();
        if (attrName === null || attrs.has(attrName)) return false;
        skipSpace();
        if (i >= len || text.charCodeAt(i) !== 0x3d /* '=' */) return false;
        i++;
        skipSpace();
        const attrValue = parseAttributeValue();
        if (attrValue === null) return false;
        attrs.set(attrName, attrValue);
      }

      if (!isSvgRootElement(tagName, attrs)) return false;
      parsedRoot = true;
      if (!selfClosing) stack.push(tagName);
      if (stack.length === 0) break;
      continue;
    }

    // Inside root element.
    const ch = text.charCodeAt(i);
    if (ch === 0x3c /* '<' */) {
      if (text.startsWith("</", i)) {
        i += 2;
        const endName = readName();
        if (endName === null) return false;
        skipSpace();
        if (i >= len || text.charCodeAt(i) !== 0x3e /* '>' */) return false;
        i++;
        if (stack.length === 0 || stack.pop() !== endName) return false;
        if (stack.length === 0) break;
      } else if (text.startsWith("<!--", i)) {
        if (!parseComment()) return false;
      } else if (text.startsWith("<![CDATA[", i)) {
        i += 9;
        const end = text.indexOf("]]>", i);
        if (end === -1) return false;
        i = end + 3;
      } else if (text.startsWith("<?", i)) {
        if (!parsePI(false)) return false;
      } else {
        i++;
        const tagName = readName();
        if (tagName === null) return false;
        const seenAttrs = new Set<string>();
        let selfClosing = false;
        while (true) {
          const beforeSpace = i;
          skipSpace();
          if (i >= len) return false;
          const c = text.charCodeAt(i);
          if (c === 0x3e /* '>' */) {
            i++;
            break;
          }
          if (c === 0x2f /* '/' */) {
            if (i + 1 >= len || text.charCodeAt(i + 1) !== 0x3e /* '>' */) return false;
            i += 2;
            selfClosing = true;
            break;
          }
          if (i === beforeSpace) return false;
          const attrName = readName();
          if (attrName === null || seenAttrs.has(attrName)) return false;
          seenAttrs.add(attrName);
          skipSpace();
          if (i >= len || text.charCodeAt(i) !== 0x3d /* '=' */) return false;
          i++;
          skipSpace();
          if (parseAttributeValue() === null) return false;
        }
        if (!selfClosing) stack.push(tagName);
      }
    } else if (ch === 0x26 /* '&' */) {
      if (!parseReference()) return false;
    } else if (ch === 0x5d /* ']' */ && text.startsWith("]]>", i)) {
      return false;
    } else {
      i++;
    }
  }

  if (!parsedRoot || stack.length !== 0) return false;

  // 4. Epilog: only whitespace, comments and processing instructions are allowed after root closes.
  while (i < len) {
    skipSpace();
    if (i >= len) break;
    if (text.startsWith("<!--", i)) {
      if (!parseComment()) return false;
    } else if (text.startsWith("<?", i)) {
      if (!parsePI(false)) return false;
    } else {
      return false;
    }
  }

  return true;
}

function skipSpaceFrom(text: string, start: number): number {
  let pos = start;
  while (pos < text.length && isXmlSpace(text.charCodeAt(pos))) pos++;
  return pos;
}

function isSvgRootElement(tagName: string, attrs: ReadonlyMap<string, string>): boolean {
  const colon = tagName.indexOf(":");
  if (colon === -1) {
    if (tagName !== "svg") return false;
    const xmlns = attrs.get("xmlns");
    return xmlns === undefined || xmlns === SVG_NAMESPACE;
  }
  // Reject multiple colons or empty prefix/local name.
  if (colon === 0 || tagName.indexOf(":", colon + 1) !== -1) return false;
  const prefix = tagName.slice(0, colon);
  const local = tagName.slice(colon + 1);
  if (local !== "svg") return false;
  return attrs.get(`xmlns:${prefix}`) === SVG_NAMESPACE;
}
