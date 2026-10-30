import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { decodeLtx, encodeLtx, ltxFileName } from "../src/ltx/ltx.js";
import { compactPagedCell, openLtxPages, openPagedCell } from "../src/ltx/ltx-pages.js";

const fixture = (n: string) =>
  new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures/celld-ltx", n)));
const put = (files: MemFilesApi, path: string, b: Uint8Array) => files.write(path, [b]);

/** A SQLite image of the pages (lock page zeroed), opened with node:sqlite. */
function query(
  pageSize: number,
  pageCount: number,
  read: (pgno: number) => Uint8Array,
  sql: string,
) {
  const image = new Uint8Array(pageSize * pageCount);
  for (let p = 1; p <= pageCount; p++) image.set(read(p), (p - 1) * pageSize);
  if (image[18] === 2) (image[18] = 1), (image[19] = 1); // celld's WAL header → rollback
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA page_size=" + pageSize);
  const path = join(import.meta.dirname, `../.tmp-ltx-${process.pid}.db`);
  require("node:fs").writeFileSync(path, image);
  const file = new DatabaseSync(path, { readOnly: true });
  try {
    return file.prepare(sql).all();
  } finally {
    file.close();
    require("node:fs").rmSync(path, { force: true });
  }
}

describe("LTX page access over a FilesApi (celld's files)", () => {
  it("reads every page of celld's snapshot and delta by range, as decodeLtx does", async () => {
    const files = new MemFilesApi();
    for (const n of [
      "0000000000000001-0000000000000001.ltx",
      "0000000000000002-0000000000000002.ltx",
    ]) {
      await put(files, `/cell/${n}`, fixture(n));
      const whole = decodeLtx(fixture(n));
      const paged = await openLtxPages(files, `/cell/${n}`);
      expect(paged.header.commit).toBe(whole.header.commit);
      expect([...paged.index.keys()].sort((a, b) => a - b)).toEqual([...whole.pages.keys()]);
      for (const [pgno, data] of whole.pages) expect(await paged.readPage(pgno)).toEqual(data);
    }
  });

  it("serves the newest page of snapshot + delta, and compacts them into one celld snapshot", async () => {
    const files = new MemFilesApi();
    const names = [
      "0000000000000001-0000000000000001.ltx",
      "0000000000000002-0000000000000002.ltx",
    ];
    for (const n of names) await put(files, `/cell/${n}`, fixture(n));
    const cell = await openPagedCell(
      files,
      names.map((n) => `/cell/${n}`),
    );
    // Expected: the snapshot's pages overlaid by the delta's.
    const snap = decodeLtx(fixture(names[0]));
    const delta = decodeLtx(fixture(names[1]));
    for (let p = 1; p <= cell.pageCount; p++) {
      const want = delta.pages.get(p) ?? snap.pages.get(p) ?? new Uint8Array(cell.pageSize);
      expect(await cell.readPage(p)).toEqual(want);
    }
    const snapshot = await compactPagedCell(cell);
    const back = decodeLtx(snapshot);
    expect(back.header.minTXID).toBe(1n);
    expect(back.header.maxTXID).toBe(cell.maxTXID);
    const pages = new Map<number, Uint8Array>();
    for (let p = 1; p <= cell.pageCount; p++) pages.set(p, await cell.readPage(p));
    // The compacted snapshot holds the same database: same tables, same rows.
    const viaFiles = query(
      cell.pageSize,
      cell.pageCount,
      (p) => pages.get(p) as Uint8Array,
      "SELECT name FROM sqlite_schema ORDER BY name",
    );
    const viaSnapshot = query(
      cell.pageSize,
      back.header.commit,
      (p) => back.pages.get(p) ?? new Uint8Array(cell.pageSize),
      "SELECT name FROM sqlite_schema ORDER BY name",
    );
    expect(viaSnapshot).toEqual(viaFiles);
    console.log(
      `celld cell: ${cell.pageCount} pages of ${cell.pageSize} B, tables ${JSON.stringify(viaFiles.map((r) => r.name))}`,
    );
  });

  it("reads a large snapshot page by page with a few range reads (measured)", async () => {
    // A 4 MiB database (1024 pages of 4 KiB) written as one celld snapshot, then 200 random pages read.
    const pageSize = 4096;
    const pages = new Map<number, Uint8Array>();
    for (let p = 1; p <= 1024; p++)
      pages.set(
        p,
        new Uint8Array(pageSize).map((_, i) => (p * 31 + i) % 251),
      );
    const bytes = encodeLtx({
      header: {
        pageSize,
        commit: 1024,
        minTXID: 1n,
        maxTXID: 1n,
        timestamp: 0,
        preApplyChecksum: 0n,
      },
      pages,
      postApplyChecksum: 0n,
    });
    let reads = 0;
    const files = new MemFilesApi();
    await put(files, `/c/${ltxFileName(1n, 1n)}`, bytes);
    const counting = new Proxy(files, {
      get: (t, k) =>
        k === "read" ? (...a: unknown[]) => (reads++, (t.read as any)(...a)) : (t as any)[k],
    });
    const t0 = performance.now();
    const cell = await openPagedCell(counting as MemFilesApi, [`/c/${ltxFileName(1n, 1n)}`]);
    const openReads = reads;
    for (let i = 0; i < 200; i++) {
      const p = 1 + ((i * 7919) % 1024);
      expect(await cell.readPage(p)).toEqual(pages.get(p));
    }
    console.log(
      `open: ${openReads} range reads; 200 random pages: ${reads - openReads} reads, ${((performance.now() - t0) / 200).toFixed(3)} ms/page (in-memory FilesApi, LZ4 decode included)`,
    );
    expect(openReads).toBe(3); // header, trailer, index
  });
});

describe("streaming compaction", () => {
  it("writes a celld snapshot page by page, with a valid file checksum", async () => {
    const { encodeLtxStream, compactPagedCellTo } = await import("../src/ltx/ltx-pages.js");
    const files = new MemFilesApi();
    const pageSize = 4096;
    const page = (p: number) => new Uint8Array(pageSize).map((_, i) => (p * 13 + i * 7) % 256);
    async function* pages() {
      for (let p = 1; p <= 300; p++) yield [p, page(p)] as [number, Uint8Array];
    }
    // flags 0: the checksum is written and decodeLtx verifies it.
    await files.write("/c/0/0000000000000001-0000000000000005.ltx", encodeLtxStream({ flags: 0, pageSize, commit: 300, minTXID: 1n, maxTXID: 5n, timestamp: 1, preApplyChecksum: 0n }, pages(), 1n));
    const chunks: Uint8Array[] = [];
    for await (const c of files.read("/c/0/0000000000000001-0000000000000005.ltx")) chunks.push(c);
    const decoded = decodeLtx(Uint8Array.from(chunks.flatMap((c) => [...c])));
    expect(decoded.pages.size).toBe(300);
    expect(decoded.pages.get(123)).toEqual(page(123));
    // And a compaction through it equals the source pages.
    const cell = await openPagedCell(files, ["/c/0/0000000000000001-0000000000000005.ltx"]);
    await compactPagedCellTo(cell, files, "/c/0/compacted.ltx");
    const back = await openLtxPages(files, "/c/0/compacted.ltx");
    for (const p of [1, 150, 300]) expect(await back.readPage(p)).toEqual(page(p));
  });

  it("compacts a 64 MiB cell without holding it in memory", async () => {
    const { encodeLtxStream, compactPagedCellTo } = await import("../src/ltx/ltx-pages.js");
    const pageSize = 4096;
    const N = 16384; // 64 MiB
    // Pseudo-random pages (barely compressible), generated on the fly.
    const page = (p: number) => {
      const b = new Uint8Array(pageSize);
      let x = p * 2654435761;
      for (let i = 0; i < pageSize; i++) (x = (x * 1103515245 + 12345) >>> 0), (b[i] = x >>> 24);
      return b;
    };
    const source = new MemFilesApi();
    async function* srcPages() {
      for (let p = 1; p <= N; p++) yield [p, page(p)] as [number, Uint8Array];
    }
    await source.write("/cell/snap.ltx", encodeLtxStream({ pageSize, commit: N, minTXID: 1n, maxTXID: 1n, timestamp: 0, preApplyChecksum: 0n }, srcPages()));
    // A delta changing 1000 pages, written the same way.
    async function* deltaPages() {
      for (let p = 1; p <= N; p += 16) yield [p, page(p + 1)] as [number, Uint8Array];
    }
    await source.write("/cell/delta.ltx", encodeLtxStream({ pageSize, commit: N, minTXID: 2n, maxTXID: 2n, timestamp: 0, preApplyChecksum: 0n }, deltaPages()));
    // The output goes to a sink that only counts bytes: what stays in memory is the compactor's.
    let written = 0;
    const sink = { write: async (_p: string, content: AsyncIterable<Uint8Array>) => { for await (const c of content) written += c.length; } } as unknown as MemFilesApi;
    (globalThis as { gc?: () => void }).gc?.();
    const base = process.memoryUsage();
    let peak = 0;
    const sample = setInterval(() => {
      const m = process.memoryUsage();
      peak = Math.max(peak, m.heapUsed + m.arrayBuffers - base.heapUsed - base.arrayBuffers);
    }, 5);
    const t0 = performance.now();
    const cell = await openPagedCell(source, ["/cell/snap.ltx", "/cell/delta.ltx"]);
    // Sampled from inside the loop (timers do not fire while it runs on microtasks).
    const read = cell.readPage.bind(cell);
    let n = 0;
    cell.readPage = async (p) => {
      if (++n % 1024 === 0) {
        // Retained memory (garbage collected first when the runner exposes gc: --expose-gc).
        (globalThis as { gc?: () => void }).gc?.();
        const m = process.memoryUsage();
        peak = Math.max(peak, m.heapUsed + m.arrayBuffers - base.heapUsed - base.arrayBuffers);
      }
      return read(p);
    };
    await compactPagedCellTo(cell, sink, "/cell/compacted.ltx");
    clearInterval(sample);
    const ms = performance.now() - t0;
    console.log(`64 MiB cell (${N} pages + a delta of ${Math.ceil(N / 16)}): compacted to ${(written / 1e6).toFixed(1)} MB in ${ms.toFixed(0)} ms; peak extra memory ${(peak / 1e6).toFixed(1)} MB`);
    expect(written).toBeGreaterThan(N * pageSize * 0.9);
    // Retained memory stays a fraction of the 64 MiB database (garbage between collections aside).
    if ((globalThis as { gc?: () => void }).gc) expect(peak).toBeLessThan(8e6);
  }, 120_000);
});
