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
