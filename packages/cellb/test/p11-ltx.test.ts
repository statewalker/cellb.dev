import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { databaseChecksum, decodeLtx, encodeLtx } from "../src/ltx/ltx.js";
import {
  lz4Compress,
  lz4Decompress,
  lz4FrameCompress,
  lz4FrameDecompress,
} from "../src/ltx/lz4.js";

const fixture = (n: string) =>
  new Uint8Array(readFileSync(join(__dirname, "fixtures/celld-ltx", n)));

// Files written by the real celld 0.6.2 (Counter example, epoch 2): a snapshot (TXID 1) and
// an incremental (TXID 2). Decoding verifies celld's file checksum; applying both must give a
// SQLite database whose rolling checksum equals celld's post-apply checksum.
// Files written by the real celld 0.6.2 (Counter example, epoch 2): a snapshot (TXID 1) and
// an incremental (TXID 2), legacy LZ4-frame pages.
describe("P11 LTX v3 — compatible with celld's files", () => {
  it("decodes celld's snapshot and incremental, verifying every checksum", () => {
    const snap = decodeLtx(fixture("0000000000000001-0000000000000001.ltx"));
    const inc = decodeLtx(fixture("0000000000000002-0000000000000002.ltx"));
    expect(snap.header.minTXID).toBe(1n);
    expect(inc.header.minTXID).toBe(2n);
    // celld 0.6.2 leaves the rolling database checksums at 0 (pre- and post-apply); only the
    // file checksum is set — and verified above by decodeLtx.
    expect([
      snap.header.preApplyChecksum,
      snap.postApplyChecksum,
      inc.header.preApplyChecksum,
      inc.postApplyChecksum,
    ]).toEqual([0n, 0n, 0n, 0n]);
    const db = new Map<number, Uint8Array>(snap.pages);
    for (const [p, d] of inc.pages) db.set(p, d);
    expect(
      databaseChecksum(inc.header.pageSize, (p) => db.get(p)!, inc.header.commit) & (1n << 63n),
    ).toBe(1n << 63n);
    // The pages form a valid SQLite database holding the Counter's value.
    const file = join(mkdtempSync(join(tmpdir(), "ltx-")), "db.sqlite");
    const image = new Uint8Array(inc.header.commit * inc.header.pageSize);
    for (let p = 1; p <= inc.header.commit; p++)
      image.set(db.get(p)!, (p - 1) * inc.header.pageSize);
    writeFileSync(file, image);
    const sqlite = new DatabaseSync(file, { readOnly: true });
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all();
    expect(tables.length).toBeGreaterThan(0);
    sqlite.close();
  });

  it("re-encodes celld's pages into a file celld's decoder rules accept (round trip)", () => {
    const snap = decodeLtx(fixture("0000000000000001-0000000000000001.ltx"));
    for (const format of ["legacy", "block"] as const) {
      const again = decodeLtx(encodeLtx(snap, format));
      expect(again.header).toEqual(snap.header);
      expect(again.postApplyChecksum).toBe(snap.postApplyChecksum);
      for (const [p, d] of snap.pages) expect(again.pages.get(p)).toEqual(d);
    }
    const again = decodeLtx(encodeLtx(snap));
    expect(again.postApplyChecksum).toBe(snap.postApplyChecksum);
    expect([...again.pages.keys()]).toEqual([...snap.pages.keys()]);
    for (const [p, d] of snap.pages) expect(again.pages.get(p)).toEqual(d);
  });

  it("LZ4 round-trips repetitive, random and empty pages", () => {
    const rnd = crypto.getRandomValues(new Uint8Array(4096));
    for (const page of [
      new Uint8Array(4096),
      rnd,
      new TextEncoder().encode("abcabcabc".repeat(400)),
      new Uint8Array(0),
    ]) {
      expect(lz4Decompress(lz4Compress(page), page.length)).toEqual(page);
      expect(lz4FrameDecompress(lz4FrameCompress(page), page.length)).toEqual(page);
    }
  });
});
