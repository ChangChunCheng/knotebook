/**
 * A non-ASCII or over-100-byte path gets a pax header (GNU tar, bsdtar and Python tarfile
 * understand it) with an ASCII fallback name. The `Z_SYNC_FLUSH` callback waits for the
 * downstream, so it is the backpressure (`drain` is only a backstop). Every wait races the
 * internal abort signal: if the downstream is destroyed, flush and `drain` never settle. An
 * abort sends no trailers; the caller destroys the socket (curl exits 18).
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Writable } from "node:stream";
import zlib from "node:zlib";

export class TarAbortError extends Error {
  constructor(cause?: unknown) {
    super("tar stream aborted");
    this.name = "AbortError";
    if (cause !== undefined) this.cause = cause;
  }
}

const BLOCK = 512;
const octal = (n: number, len: number): string => n.toString(8).padStart(len - 1, "0") + "\0";
const padOf = (n: number): Buffer => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK, 0);
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export function needsPax(name: string): boolean {
  return !PRINTABLE_ASCII.test(name) || Buffer.byteLength(name, "utf8") > 100;
}

/** `name` must be printable ASCII of at most 100 bytes (the caller passes the fallback name). */
export function ustarHeader(h: { name: string; size: number; type: "0" | "5" | "x"; mode: number; mtime: number }): Buffer {
  const b = Buffer.alloc(BLOCK, 0);
  b.write(h.name, 0, 100, "ascii");
  b.write(octal(h.mode, 8), 100, "ascii");
  b.write(octal(0, 8), 108, "ascii");
  b.write(octal(0, 8), 116, "ascii");
  b.write(octal(h.size, 12), 124, "ascii");
  b.write(octal(h.mtime, 12), 136, "ascii");
  b.write("        ", 148, "ascii");
  b.write(h.type, 156, "ascii");
  b.write("ustar\0", 257, "ascii");
  b.write("00", 263, "ascii");
  let sum = 0;
  for (const x of b) sum += x;
  b.write(octal(sum, 7) + " ", 148, "ascii");
  return b;
}

/** `len` counts its own digits, hence the second pass when the digit count carries. */
export function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const len = Buffer.byteLength(body, "utf8");
  let total = len + String(len).length;
  if (String(total).length !== String(len).length) total = len + String(total).length;
  return Buffer.from(`${total}${body}`, "utf8");
}

function fallbackName(name: string, dir: boolean): string {
  return "PaxHeader-fallback/" + createHash("sha1").update(name, "utf8").digest("hex").slice(0, 16) + (dir ? "/" : "");
}

export function entryBytes(name: string, type: "0" | "5", data: Buffer, mtime: number): Buffer[] {
  const out: Buffer[] = [];
  const dir = type === "5";
  if (needsPax(name)) {
    const rec = paxRecord("path", name);
    out.push(ustarHeader({ name: "PaxHeader", size: rec.length, type: "x", mode: 0o644, mtime }), rec, padOf(rec.length));
  }
  out.push(ustarHeader({ name: needsPax(name) ? fallbackName(name, dir) : name, size: data.length, type, mode: dir ? 0o755 : 0o644, mtime }));
  if (data.length > 0) out.push(data, padOf(data.length));
  return out;
}

export class TarGzWriter {
  private readonly gz: zlib.Gzip;
  private readonly ac = new AbortController();
  private readonly mtime: number;
  private bytes = 0;

  constructor(
    private readonly out: Writable,
    opts: { mtime: Date },
  ) {
    this.mtime = Math.floor(opts.mtime.getTime() / 1000);
    this.gz = zlib.createGzip();
    this.gz.on("error", err => this.abort(err));
    this.gz.on("data", (c: Buffer) => {
      this.bytes += c.length;
    });
    this.gz.pipe(out);
    const gone = (err?: unknown) => this.abort(err ?? new Error("output closed"));
    out.once("close", () => gone());
    out.once("error", err => gone(err));
  }

  get bytesOut(): number {
    return this.bytes;
  }

  get aborted(): boolean {
    return this.ac.signal.aborted;
  }

  addDir(path: string): Promise<void> {
    return this.addEntry(path.endsWith("/") ? path : path + "/", "5", Buffer.alloc(0));
  }

  addFile(path: string, data: Buffer): Promise<void> {
    return this.addEntry(path, "0", data);
  }

  async finish(): Promise<void> {
    this.check();
    const signal = this.ac.signal;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        this.out.removeListener("finish", onFinish);
        this.out.removeListener("close", onClose);
      };
      const onAbort = () => {
        cleanup();
        reject(new TarAbortError(signal.reason));
      };
      const onFinish = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new TarAbortError(new Error("output closed before finish")));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.out.once("finish", onFinish);
      this.out.once("close", onClose);
      this.gz.end(Buffer.alloc(BLOCK * 2, 0));
    });
  }

  abort(reason?: unknown): void {
    if (this.ac.signal.aborted) return;
    this.ac.abort(reason ?? new Error("aborted"));
    this.gz.unpipe(this.out);
    this.gz.destroy();
  }

  private check(): void {
    if (this.ac.signal.aborted) throw new TarAbortError(this.ac.signal.reason);
  }

  private async addEntry(name: string, type: "0" | "5", data: Buffer): Promise<void> {
    this.check();
    for (const b of entryBytes(name, type, data, this.mtime)) await this.write(b);
    await this.flush();
  }

  private async write(buf: Buffer): Promise<void> {
    this.check();
    if (!this.gz.write(buf)) {
      try {
        await once(this.gz, "drain", { signal: this.ac.signal });
      } catch (err) {
        throw new TarAbortError(err);
      }
    }
  }

  private flush(): Promise<void> {
    const signal = this.ac.signal;
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new TarAbortError(signal.reason));
      const onAbort = () => reject(new TarAbortError(signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });
      this.gz.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(new TarAbortError(signal.reason));
        else resolve();
      });
    });
  }
}
