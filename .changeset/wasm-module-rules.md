---
"@statewalker/cellb": minor
---

Non-JS imports follow wrangler's module rules: `import mod from "./add.wasm"` (and `./add.wasm?module`) gives a compiled `WebAssembly.Module`, as workerd's `CompiledWasm` rule; `.bin` an `ArrayBuffer` (`Data`); `.txt`, `.html`, `.sql` a string (`Text`). A project's own `rules` (`CompiledWasm`, `Data`, `Text`, with `globs` and `fallthrough`) are honoured. `loadProject` on Node and `cellb build` inline the bytes, so a built `worker.js` stays self-contained for browsers.
