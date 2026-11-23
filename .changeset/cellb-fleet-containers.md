---
"@statewalker/cellb": minor
---

Fleet nodes run containers. `startFleetNode({ containers })` and `cellb serve --containers MODULE` (`CELLB_CONTAINERS`) give the node a container engine for the project's `containers` classes; the module's default export is the engine or a function that makes one (`loadContainerEngine` from `@statewalker/cellb/node`). A cell's container runs on the node that owns the cell: when the cell moves (its node dies or leaves), the next owner starts the same image (`cellb.containers.<class>`) and runs the same scripts, and the cell's storage goes on. Before, a fleet node reported every `containers` class as unsupported.
