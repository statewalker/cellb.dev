---
"@statewalker/cellb": patch
---

`lowerAwait` (the fallback that lowers async functions for a browser build with a top-level await, such as a `.wasm` import) passed `arguments` to a lowered async arrow whenever the word appeared in its body, in a string, a comment or a nested function's own `arguments`. In a class field or a static block that is a SyntaxError (`'arguments' is not allowed in class field initializer`), so such a bundle failed to load. An arrow now gets its enclosing function's `arguments` only when it reads them itself.
