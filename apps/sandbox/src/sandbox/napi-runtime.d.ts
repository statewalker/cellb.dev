// Types for the Astro compiler's WebAssembly runtime (as packages/platform-core/src/types.d.ts).
declare module "@napi-rs/wasm-runtime" {
  export const getDefaultContext: () => unknown;
  export const instantiateNapiModuleSync: (
    wasm: unknown,
    options: unknown,
  ) => { napiModule: { exports: unknown } };
  export class WASI {
    constructor(options: { version: string });
  }
}
