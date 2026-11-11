---
"@statewalker/cellb": patch
---

Only `nodejs_compat` and `nodejs_compat_v2` turn on Node.js compatibility, as in workerd and Wrangler. Before, any flag starting with `nodejs_compat` did, so a project with only `nodejs_compat_populate_process_env` got the Node.js modules and a filled `process.env` that workerd would not give it.
