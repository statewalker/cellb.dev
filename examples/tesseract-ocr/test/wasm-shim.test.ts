// The wasm shim directly on Node: engines created at the same time (cells sharing an isolate's
// globals) must leave no patch behind, and pdf.js's marker-keyed decoders must keep working.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEngine } from "../src/ocr.ts";
import { registerPrecompiledWasm } from "../src/wasm-shim.ts";
import { root } from "./app.ts";

const tesseract = new WebAssembly.Module(
  readFileSync(join(root, "node_modules/tesseract-wasm/dist/tesseract-core.wasm")),
);
const model = new Uint8Array(readFileSync(join(root, "fixtures/models/eng.traineddata")));
// The smallest module there is: the magic number and the version.
const empty = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

describe("withPrecompiledWasm", () => {
  it("creates engines concurrently without leaving URL or instantiate patched", async () => {
    // The dispatcher is installed once, for good: take the globals after it is.
    registerPrecompiledWasm({ "empty.wasm": empty });
    const url = globalThis.URL;
    const instantiate = WebAssembly.instantiate;

    const [a, b, c] = await Promise.all([1, 2, 3].map(() => createEngine(tesseract, model)));

    expect(globalThis.URL).toBe(url);
    expect(WebAssembly.instantiate).toBe(instantiate);
    for (const e of [a, b, c]) expect(e.probe.memory).toBeInstanceOf(WebAssembly.Memory);
    expect(new Set([a, b, c].map((e) => e.probe.memory)).size).toBe(3);
    // A marker another library holds still gets its own module, not Tesseract's.
    const { markerFor } = registerPrecompiledWasm({});
    const { module } = (await WebAssembly.instantiate(
      markerFor("empty.wasm"),
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    expect(module).toBe(empty);
    // And a relative URL against a base it cannot resolve throws again, outside creation.
    expect(() => new URL("x.wasm", "blob:http://h/uuid")).toThrow();
  });
});
