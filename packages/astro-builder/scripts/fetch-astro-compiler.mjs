// Fetches Astro's compiler as WebAssembly (@astrojs/compiler-binding-wasm32-wasi, the binding of
// @astrojs/compiler-rs) from the npm registry into vendor/astro-compiler/, for the tests (pnpm
// does not install it on x64: `cpu: wasm32`). The platform itself takes it from its package store
// at run time. Idempotent: does nothing when the file is there.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const NAME = "@astrojs/compiler-binding-wasm32-wasi";
const VERSION = "0.5.2";
const FILE = "astro.wasm32-wasi.wasm";
const dir = resolve(import.meta.dirname, "../vendor/astro-compiler");
const out = join(dir, FILE);

export async function fetchAstroCompiler() {
  if (existsSync(out)) return out;
  const url = `https://registry.npmjs.org/${NAME}/-/compiler-binding-wasm32-wasi-${VERSION}.tgz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const tar = gunzipSync(new Uint8Array(await res.arrayBuffer()));
  for (let at = 0; at + 512 <= tar.length; ) {
    const name = new TextDecoder().decode(tar.subarray(at, at + 100)).replace(/\0.*$/s, "");
    if (!name) break;
    const size = Number.parseInt(
      new TextDecoder()
        .decode(tar.subarray(at + 124, at + 136))
        .replace(/\0.*$/s, "")
        .trim(),
      8,
    );
    if (name === `package/${FILE}`) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(out, tar.subarray(at + 512, at + 512 + size));
      return out;
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${FILE} not found in ${url}`);
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(await fetchAstroCompiler());
