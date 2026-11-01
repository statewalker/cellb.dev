// The part of @napi-rs/wasm-runtime's API that browser.ts uses; the package ships no types.
declare module "@napi-rs/wasm-runtime" {
  export function getDefaultContext(): unknown;
  export function instantiateNapiModuleSync(
    wasm: Uint8Array | WebAssembly.Module,
    options: unknown,
  ): { instance: WebAssembly.Instance; napiModule: { exports: unknown } };
  export class WASI {
    constructor(options: { version: "preview1" | "unstable" });
  }
}
