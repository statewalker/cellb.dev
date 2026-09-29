export {
  CellRouter,
  linkOverPort,
  remoteRuntime,
  serveHandlerOverPort,
  shardOf,
} from "../src/index.js";

import { idFromName } from "../src/core/id.js";
export const idFromNameForTest = (ns: string, name: string) => idFromName(ns, name).toString();
