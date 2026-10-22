import type { FilesApi } from "@statewalker/webrun-files";
// @ts-expect-error — vendored JS (scripts/vendor-celld.mjs)
import { kvService } from "../../vendor/celld/kv.js";
import { DurableObject } from "../core/durable-object.js";

/**
 * KV exactly as celld implements it: celld's own `services/kv.js` (namespace cell + binding
 * client, Apache-2.0) on a webrun-cells host. The limits are celld_logic::kv's constants;
 * values above 1 MiB go to a FilesApi (celld: the fleet bucket) through the same
 * prepare / put / get / sweep protocol.
 */
export const CELLD_KV_LIMITS = {
  maxKeyBytes: 512,
  maxValueBytes: 25 * 1024 * 1024,
  maxInlineValueBytes: 1024 * 1024,
  maxMetadataBytes: 1024,
  minExpirationTtlMs: 60_000,
  maxBulkKeys: 100,
  maxListLimit: 1000,
  sweepBatchRows: 256,
  blobSweepMs: 60_000,
  sweepDisabled: false,
  legacySchema: false,
  failAfterBlobWrite: false,
  raceSweepPut: false,
};

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function readAll(files: FilesApi, path: string): Promise<Uint8Array | undefined> {
  if (!(await files.exists(path))) return undefined;
  const chunks: Uint8Array[] = [];
  for await (const c of files.read(path)) chunks.push(c);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

export function celldKv(files: FilesApi, root = "/kv-blobs") {
  const dirOf = (cell: { ctx: { id: { toString(): string } } }) =>
    `${root}/${cell.ctx.id.toString()}`;
  return kvService({
    DurableObject,
    limits: () => CELLD_KV_LIMITS,
    blob: async (cell: any, request: any, value?: Uint8Array) => {
      const dir = dirOf(cell);
      switch (request.mode) {
        case "prepare":
          return { reference: `${request.digest}-${crypto.randomUUID().replace(/-/g, "")}` };
        case "put":
          await files.write(`${dir}/${request.reference}`, [value as Uint8Array]);
          return { ok: true };
        case "get": {
          const bytes = await readAll(files, `${dir}/${request.reference}`);
          return bytes ? { found: true, value: bytes } : { found: false };
        }
        case "sweep": {
          const live = new Set<string>(request.live ?? []);
          if (await files.exists(dir))
            for await (const f of files.list(dir)) {
              const name = f.path.split("/").pop() ?? "";
              if (f.kind === "file" && !live.has(name)) await files.remove(f.path);
            }
          return { ok: true };
        }
        default:
          throw new Error(`unknown KV blob mode ${request.mode}`);
      }
    },
    btoa: (bytes: Uint8Array) => b64(bytes),
    atob: (text: string) => unb64(text),
  }) as {
    KvNamespaceCell: unknown;
    KvNamespace: new (ns: () => unknown, cellName: string) => unknown;
  };
}
