---
"@statewalker/cellb": patch
---

Browser loader: a literal `import("./x.js")` of a module the loaded Worker does not have fails when it runs ("No such module"), as on workerd and on Node, instead of failing the whole load. Kitesurf's page runtime imports its classic-script module this way and has it only for pages with `<script>` tags, so pages without scripts could not be opened in a browser.
