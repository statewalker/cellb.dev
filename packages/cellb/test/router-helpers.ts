export {
  CellRouter,
  linkOverPort,
  remoteRuntime,
  serveHandlerOverPort,
  shardOf,
} from "../src/index.js";

import { idFromName, namespaceKey } from "../src/core/id.js";
/** The id a runtime with the default script name ("worker") derives for `className`/`name`. */
export const idFromNameForTest = (className: string, name: string) =>
  idFromName(namespaceKey("worker", className), name).toString();
