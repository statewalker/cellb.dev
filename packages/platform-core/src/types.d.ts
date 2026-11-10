// Minimal ambient types for the Workers runtime surface this package uses. The same code runs on
// workerd (Wrangler, Cloudflare), celld and cellb, which all provide `cloudflare:workers`.
declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown> {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}

interface SqlCursor<T> extends Iterable<T> {
  toArray(): T[];
  one(): T;
}
interface SqlStorage {
  exec<T = Record<string, SqlValue>>(query: string, ...bindings: unknown[]): SqlCursor<T>;
}
type SqlValue = string | number | null | ArrayBuffer;

interface DurableObjectState {
  storage: { sql: SqlStorage; transactionSync?<T>(fn: () => T): T };
  waitUntil(p: Promise<unknown>): void;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}
interface DurableObjectStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
  getByName?(name: string): DurableObjectStub;
}
interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "@napi-rs/wasm-runtime" {
  export const getDefaultContext: () => unknown;
  export const instantiateNapiModuleSync: (
    wasm: unknown,
    options: unknown,
  ) => { napiModule: { exports: unknown } };
  export class WASI {
    constructor(options: { version: string });
  }
}

/** The Astro builder Worker's source (src/astro/loaded-builder.ts), bundled by scripts/build.mjs. */
declare module "virtual:astro-builder-source" {
  const source: string;
  export default source;
}
