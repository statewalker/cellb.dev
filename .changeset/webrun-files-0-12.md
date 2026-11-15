---
"@statewalker/cellb": minor
---

**Move to `@statewalker/webrun-files` 0.12, with the webrun-sites releases built on it.** The dependency ranges move:
- webrun-files, -browser, -mem and -node go to ^0.12.0;
- the optional peers move to webrun-bundler ^0.2.0, webrun-modules ^0.4.0, webrun-site-builder ^0.3.0 and webrun-site-host ^0.4.0.

These are breaking lines. webrun-files 0.12 resolves `..` segments before any filter, guard or mount sees a path, and throws `Path climbs above the root` above the root. Consumers must use the same lines, so a single copy of the webrun-files core is installed. webrun-site-builder 0.3 uses the global `URLPattern` (Node 24 or newer, or a browser).
