---
"@statewalker/cellb": patch
---

The fragment host's default entry is the project's one declared Durable Object binding even when it also has D1, KV, queues or workflows (the runtime's hidden bindings are never an entry), and conformance runs celld's examples side by side in one fragment host (#191).
