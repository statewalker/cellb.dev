---
"@statewalker/cellb": patch
---

The browser Worker Loader rewrote a loaded module's imports (`cloudflare:workers` → its shim, relative paths → sibling Blob URLs) with a regex over the whole text, so the same words inside a string, a template, a comment or a regular expression were rewritten too: a code generator whose template contains `from "cloudflare:workers"` emitted a `blob:` URL. The module is now scanned as code, and only its own `import … from`, `import "…"`, `export … from` and `import(…)` specifiers are rewritten.
