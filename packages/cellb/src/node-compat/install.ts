import { Buffer } from "buffer";
import { process } from "./process.js";

/**
 * nodejs_compat also exposes `Buffer` and `process` on `globalThis` (as workerd/celld do).
 * Call in the realm that runs the Worker code (a browser worker), before importing it.
 */
export function installNodeGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  g.Buffer ??= Buffer;
  g.process ??= process;
}
