---
"@statewalker/cellb": minor
---

`loadProject(source, options)` in both `@statewalker/cellb/node` and `@statewalker/cellb/browser` (#67): the same name and options (`data`, `bucket`, `ai`, and in browsers `sqlite3` and `isolateScript`), returning `{ config, runtime, unsupported, fetch, close }`. Node loads a wrangler folder (bundled with esbuild, as `loadNodeProject`), a built folder, or a FilesApi holding either; a browser loads a built folder by URL or from a FilesApi, starting SQLite WASM, the OPFS pool (`<data>`), the files directory (`<data>-files`) and the package's own isolate worker itself. The new `cellb build <dir> --out <folder>` command (and `buildProject`) writes that folder: `wrangler.json`, `worker.js` (bundled for browsers), `assets/` and a `cellb.json` manifest. `browserProjectRuntime`'s `isolateScript` also takes a function that starts the Dedicated Worker. `loadNodeProject` and `browserProjectRuntime` stay as the lower-level calls.
