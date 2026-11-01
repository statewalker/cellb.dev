---
"@statewalker/cellb": patch
---

`loadNodeProject` with `nodejs_compat` under plain Node: CommonJS dependencies of a Worker can `require()` Node's built-ins (mime-types requires `node:path`), as under workerd's nodejs_compat. The ES module bundle gets a `require` made with `createRequire`; before, it failed with `Dynamic require of "node:path" is not supported` outside vitest, whose module runner provided one.
