---
"@statewalker/cellb": patch
---

"Remove with data" deletes a fragment's isolated Workers' storage too (statewalker/cellb.dev#251). Their OPFS SQLite pools in a browser shard are now named `.<pool>-ISO-<id>`: fragment ids are lowercase, so no other fragment's name can begin so, and the removal deletes them exactly, with those of the former name `.<pool>-iso-<id>` whose id holds no `-shard-`.

Migration: an isolate whose pool exists under the former `-iso-` name and not under the new one goes on opening it (nothing is renamed or copied), and new isolates use the new name. Rollback: an earlier version opens the former names as before; pools created under the new name are not seen by it (their facets start empty there).
