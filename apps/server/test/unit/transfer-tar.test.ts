import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import zlib from "node:zlib";
import { TarGzWriter, paxRecord } from "../../src/transfer/tar.js";
import { parseTar, readPartialTarGz, readTarGz } from "../tar-read.js";

const MTIME = new Date("2026-11-02T00:00:00Z");
const cjk64 = "資料夾名稱很長".repeat(10).slice(0, 64);
const title64 = "會議紀錄標題非常長的筆記".repeat(6).slice(0, 64);
const a64 = "a".repeat(64);
const b64s = "b".repeat(64);
/** The 21-entry list (directories carry no trailing slash). */
const ENTRIES: Array<{ dir: string } | { name: string }> = [
  { dir: "My notes" },
  { dir: "Groups" },
  { dir: "Shared with me" },
  { dir: ".knotebook" },
  { name: "My notes/會議紀錄.md" },
  { dir: "My notes/專案" },
  { dir: "My notes/專案/子資料夾" },
  { name: "My notes/專案/子資料夾/中文標題 (2).md" },
  { name: "My notes/\u{1F680} launch ✓.md" },
  { name: "My notes/café NFC é.md" },
  { name: "My notes/sym #%&'[]{}=+,;@!$^~`.md" },
  { name: "My notes/ascii-only.md" },
  { dir: "My notes/空資料夾" },
  { dir: `Groups/${cjk64}` },
  { dir: `Groups/${cjk64}/${cjk64}` },
  { dir: `Groups/${cjk64}/${cjk64}/${cjk64}` },
  { name: `Groups/${cjk64}/${cjk64}/${cjk64}/${title64}.md` },
  { dir: `Shared with me/${a64}` },
  { dir: `Shared with me/${a64}/${b64s}` },
  { name: `Shared with me/${a64}/${b64s}/${"c".repeat(64)}.md` },
  { name: ".knotebook/manifest.json" },
];
const bodyOf = (n: string) => Buffer.from(`---\nknotebook: 1\ntitle: ${JSON.stringify(n)}\n---\n內容 ${n}\n`, "utf8");

/** Collecting Writable; while `hold` is set the write callback is not called (= downstream does not consume), and after `release()` it consumes. */
function sink(opts: { hold?: boolean; highWaterMark?: number } = {}) {
  const chunks: Buffer[] = [];
  let holding = opts.hold ?? false;
  const pending: Array<() => void> = [];
  const w = new Writable({
    highWaterMark: opts.highWaterMark ?? 16 * 1024,
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk);
      if (holding) pending.push(cb);
      else cb();
    },
  });
  return {
    w,
    bytes: () => Buffer.concat(chunks),
    release: () => {
      holding = false;
      for (const cb of pending.splice(0)) cb();
    },
  };
}
const settle = <T>(p: Promise<T>) => {
  const s: { state: "pending" | "resolved" | "rejected"; err?: unknown } = { state: "pending" };
  p.then(
    () => void (s.state = "resolved"),
    e => {
      s.state = "rejected";
      s.err = e;
    },
  );
  return s;
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function writeAll(w: TarGzWriter) {
  for (const e of ENTRIES) {
    if ("dir" in e) await w.addDir(e.dir);
    else await w.addFile(e.name, bodyOf(e.name));
  }
}

describe("TarGzWriter", () => {
  it("round trip: 21 entries (CJK, emoji, e-acute, symbols, an empty folder, a CJK long path of ~270 code points, ASCII > 100 bytes): names, types, content and order all equal one by one", async () => {
    const s = sink();
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    await writeAll(w);
    await w.finish();
    const got = readTarGz(s.bytes());
    expect(got.map(e => [e.type, e.path])).toEqual(ENTRIES.map(e => ("dir" in e ? ["dir", e.dir] : ["file", e.name])));
    for (const [k, e] of ENTRIES.entries()) if ("name" in e) expect(got[k]!.data.equals(bodyOf(e.name)), e.name).toBe(true);
    expect(w.bytesOut).toBe(s.bytes().length);
  });

  it("ASCII names of <= 100 bytes get no pax record, all others do; a self-length-containing pax record is also right when the digit count carries", async () => {
    const s = sink();
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    await writeAll(w);
    await w.finish();
    const { headers } = parseTar(zlib.gunzipSync(s.bytes()));
    const pax = headers.filter(h => h.type === "x").length;
    const want = ENTRIES.map(e => ("dir" in e ? e.dir + "/" : e.name)).filter(n => !/^[\x20-\x7e]*$/.test(n) || Buffer.byteLength(n) > 100).length;
    expect(pax).toBe(want);
    expect(want).toBeGreaterThan(5);
    expect(headers.filter(h => h.type !== "x").map(h => h.name)).toContain("My notes/ascii-only.md");
    // self-contained length: body length 94 -> 94+2=96; body length 98 -> 98+2=100 (three digits) -> compute again to 101
    for (const v of ["x".repeat(84), "x".repeat(88), "x".repeat(89), "é".repeat(500)]) {
      const r = paxRecord("path", v);
      expect(Number(r.toString("utf8").split(" ")[0]), v.length.toString()).toBe(r.length);
    }
  });

  it("the checksum of every 512-byte header recomputes to the field value", async () => {
    const s = sink();
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    await writeAll(w);
    await w.finish();
    const { headers } = parseTar(zlib.gunzipSync(s.bytes()));
    expect(headers.length).toBeGreaterThan(21);
    for (const h of headers) expect(h.checksumField, h.name).toBe(h.checksumComputed);
  });

  it("per-file flush: when each addFile resolves, the bytes received so far (decompressed with SYNC_FLUSH) already contain the complete content of the entry just written", async () => {
    const s = sink();
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    for (let i = 0; i < 5; i++) {
      const data = Buffer.from(`note ${i} `.repeat(200 + i));
      await w.addFile(`My notes/n${i}.md`, data);
      const seen = readPartialTarGz(s.bytes());
      expect(seen.map(e => e.path)).toEqual(Array.from({ length: i + 1 }, (_, k) => `My notes/n${k}.md`));
      expect(seen[i]!.data.equals(data)).toBe(true);
    }
    await w.finish();
  });

  it("backpressure: downstream highWaterMark 16 and not consuming -> addFile of 1 MiB of random bytes is still unresolved after 50 ms; resolves once downstream starts consuming", async () => {
    const s = sink({ hold: true, highWaterMark: 16 });
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    const st = settle(w.addFile("My notes/big.bin", randomBytes(1024 * 1024)));
    await sleep(50);
    expect(st.state).toBe("pending");
    s.release();
    for (let i = 0; i < 100 && st.state === "pending"; i++) await sleep(10);
    expect(st.state).toBe("resolved");
    await w.finish();
    expect(readTarGz(s.bytes()).map(e => e.path)).toEqual(["My notes/big.bin"]);
  });

  it("after abort the output does not read as a complete archive; after finish the last 1024 bytes (decompressed) are all zero", async () => {
    const a = sink();
    const wa = new TarGzWriter(a.w, { mtime: MTIME });
    await wa.addFile("My notes/a.md", Buffer.from("a"));
    wa.abort();
    expect(() => readTarGz(a.bytes())).toThrow();
    const b = sink();
    const wb = new TarGzWriter(b.w, { mtime: MTIME });
    await wb.addFile("My notes/a.md", Buffer.from("a"));
    await wb.finish();
    const tar = zlib.gunzipSync(b.bytes());
    expect(tar.length % 512).toBe(0);
    expect(tar.subarray(tar.length - 1024).every(x => x === 0)).toBe(true);
  });

  it("abort releases waiting: when downstream is not consuming, a pending addFile rejects with AbortError within 100 ms of abort; after that addFile / addDir / finish reject at once", async () => {
    const s = sink({ hold: true, highWaterMark: 16 });
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    const st = settle(w.addFile("My notes/big.bin", randomBytes(1024 * 1024)));
    await sleep(50);
    expect(st.state, "前提：50 ms 時仍 pending").toBe("pending");
    w.abort(new Error("stop"));
    for (let i = 0; i < 10 && st.state === "pending"; i++) await sleep(10);
    expect(st.state).toBe("rejected");
    expect((st.err as Error).name).toBe("AbortError");
    await expect(w.addFile("x", Buffer.from("x"))).rejects.toMatchObject({ name: "AbortError" });
    await expect(w.addDir("x")).rejects.toMatchObject({ name: "AbortError" });
    await expect(w.finish()).rejects.toMatchObject({ name: "AbortError" });
    w.abort(); // idempotent
  });

  it("downstream itself destroyed (simulating a socket drop) -> a pending addFile rejects within 100 ms", async () => {
    const s = sink({ hold: true, highWaterMark: 16 });
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    const st = settle(w.addFile("My notes/big.bin", randomBytes(1024 * 1024)));
    await sleep(50);
    expect(st.state, "前提：50 ms 時仍 pending").toBe("pending");
    s.w.destroy();
    for (let i = 0; i < 10 && st.state === "pending"; i++) await sleep(10);
    expect(st.state).toBe("rejected");
    expect((st.err as Error).name).toBe("AbortError");
    expect(w.aborted).toBe(true);
  });

  it("downstream destroyed while finish is in progress -> finish rejects with AbortError, does not resolve", async () => {
    const s = sink({ hold: true, highWaterMark: 16 });
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    const st = settle(w.finish());
    await sleep(30);
    expect(st.state, "前提：下游不消化時 finish 未完成").toBe("pending");
    s.w.destroy();
    for (let i = 0; i < 10 && st.state === "pending"; i++) await sleep(10);
    expect(st.state).toBe("rejected");
    expect((st.err as Error).name).toBe("AbortError");
  });

  const hasGnuTar = (() => {
    if (process.platform === "win32") return false;
    try {
      return /GNU tar/.test(execFileSync("tar", ["--version"], { encoding: "utf8" }));
    } catch {
      return false;
    }
  })();
  it.runIf(hasGnuTar)("GNU tar -tzf lists names = the list", async () => {
    const s = sink();
    const w = new TarGzWriter(s.w, { mtime: MTIME });
    await writeAll(w);
    await w.finish();
    const dir = mkdtempSync(path.join(tmpdir(), "kn-tar-"));
    try {
      const f = path.join(dir, "t.tar.gz");
      writeFileSync(f, s.bytes());
      const listed = execFileSync("tar", ["-tzf", f], { encoding: "utf8" }).split("\n").filter(Boolean);
      expect(listed).toEqual(ENTRIES.map(e => ("dir" in e ? e.dir + "/" : e.name)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
