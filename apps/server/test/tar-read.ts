/**
 * Understands pax `path` (`x`-type headers); types other than ustar throw.
 * `readTarGz`: gzip must be complete and tar must end with two zero blocks, otherwise it throws (that is how an aborted stream is recognised).
 */
import zlib from "node:zlib";

export interface TarEntry {
  /** `dir` has no trailing slash. */
  path: string;
  type: "file" | "dir";
  data: Buffer;
}
export interface TarHeaderInfo {
  name: string;
  type: string;
  size: number;
  checksumField: number;
  checksumComputed: number;
}

const BLOCK = 512;
const cstr = (b: Buffer, start: number, len: number) => {
  const s = b.subarray(start, start + len);
  const z = s.indexOf(0);
  return (z === -1 ? s : s.subarray(0, z)).toString("utf8");
};
const oct = (b: Buffer, start: number, len: number) => parseInt(cstr(b, start, len).trim() || "0", 8);

function parsePax(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp === -1) throw new Error("pax: bad record");
    const len = Number(buf.subarray(i, sp).toString("ascii"));
    if (!Number.isInteger(len) || len <= 0) throw new Error("pax: bad length");
    const rec = buf.subarray(sp + 1, i + len).toString("utf8");
    if (!rec.endsWith("\n")) throw new Error("pax: record length mismatch");
    const eq = rec.indexOf("=");
    out[rec.slice(0, eq)] = rec.slice(eq + 1, -1);
    i += len;
  }
  return out;
}

export function parseTar(tar: Buffer, opts: { requireEnd: boolean } = { requireEnd: true }): { entries: TarEntry[]; headers: TarHeaderInfo[]; ended: boolean } {
  const entries: TarEntry[] = [];
  const headers: TarHeaderInfo[] = [];
  let pos = 0;
  let pax: Record<string, string> | null = null;
  let ended = false;
  while (pos + BLOCK <= tar.length) {
    const h = tar.subarray(pos, pos + BLOCK);
    if (h.every(x => x === 0)) {
      const next = tar.subarray(pos + BLOCK, pos + 2 * BLOCK);
      if (next.length === BLOCK && next.every(x => x === 0)) {
        ended = true;
        break;
      }
      throw new Error("tar: lone zero block");
    }
    const name = cstr(h, 0, 100);
    const type = String.fromCharCode(h[156]!);
    const size = oct(h, 124, 12);
    const checksumField = oct(h, 148, 8);
    let checksumComputed = 0;
    for (let k = 0; k < BLOCK; k++) checksumComputed += k >= 148 && k < 156 ? 0x20 : h[k]!;
    headers.push({ name, type, size, checksumField, checksumComputed });
    if (checksumField !== checksumComputed) throw new Error(`tar: checksum mismatch at ${pos}`);
    if (h.subarray(257, 263).toString("ascii") !== "ustar\0") throw new Error("tar: not ustar");
    const dataStart = pos + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      if (opts.requireEnd) throw new Error("tar: truncated entry");
      break;
    }
    const data = Buffer.from(tar.subarray(dataStart, dataEnd));
    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      pax = parsePax(data);
      continue;
    }
    if (type !== "0" && type !== "\0" && type !== "5") throw new Error(`tar: unsupported type ${JSON.stringify(type)}`);
    let path = pax?.path ?? name;
    pax = null;
    const isDir = type === "5";
    if (isDir && path.endsWith("/")) path = path.slice(0, -1);
    entries.push({ path, type: isDir ? "dir" : "file", data });
  }
  if (opts.requireEnd && !ended) throw new Error("tar: missing end-of-archive");
  return { entries, headers, ended };
}

export function readTarGz(buf: Buffer): TarEntry[] {
  return parseTar(zlib.gunzipSync(buf)).entries;
}

/** Bytes of a half-sent stream: inflated with Z_SYNC_FLUSH, tar need not have an end. */
export function readPartialTarGz(buf: Buffer): TarEntry[] {
  return parseTar(zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }), { requireEnd: false }).entries;
}
