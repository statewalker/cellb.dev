// A `.wasm` import is a compiled WebAssembly.Module (workerd's CompiledWasm rule; cellb >= 0.8,
// celld and wrangler apply it).
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
