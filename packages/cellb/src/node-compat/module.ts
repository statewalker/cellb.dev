/**
 * `node:module` for browsers (nodejs_compat): `createRequire` as workerd has it. The `require`
 * it returns loads the Node.js built-ins cellb polyfills (`require("crypto")`, bare or
 * `node:`-prefixed) and throws for anything else. Bundlers emit `createRequire(import.meta.url)`
 * at module scope for CommonJS dependencies that `require()` built-ins, so the call itself must
 * not throw.
 */
import { nodeRegistryEntries } from "./browser-registry.js";

const builtins = Object.keys(nodeRegistryEntries).filter((k) => k.startsWith("node:"));

export const builtinModules = builtins.map((k) => k.slice("node:".length));

export function isBuiltin(id: string): boolean {
  return builtins.includes(id.startsWith("node:") ? id : `node:${id}`);
}

export function createRequire(_from: string | URL) {
  const require = (id: string): unknown => {
    const name = id.startsWith("node:") ? id : `node:${id}`;
    if (Object.hasOwn(nodeRegistryEntries, name)) return nodeRegistryEntries[name];
    const err = new Error(`Cannot find module '${id}' (nodejs_compat in a browser)`);
    (err as Error & { code?: string }).code = "MODULE_NOT_FOUND";
    throw err;
  };
  return Object.assign(require, {
    resolve: (id: string) => {
      if (isBuiltin(id)) return id.startsWith("node:") ? id : `node:${id}`;
      require(id);
      return id;
    },
    cache: Object.create(null),
  });
}

export default { builtinModules, isBuiltin, createRequire };
