// Service bindings between projects (statewalker/cellb.dev#192; statewalker-root ADR
// 2026-11-21-fragment-host-and-routing): `services: [{ binding, service, entrypoint? }]` naming
// another project a fragment host holds gives a binding whose transport follows placement.
//
// The target is the project's entrypoint (its default export, or a named `WorkerEntrypoint`).
// Where it runs follows the project's fragment DO, its anchor: the binding asks the host per call
// (`ServiceResolver`), and the host answers
//   - `runtime`: the project is in this runtime and its fragment DO on this shard: in-runtime JS RPC;
//   - `link`: on another shard or tab (a MessagePort, through the router), or on another host
//     (HTTP, `/fragments/{id}/…` or `/peers/{peerId}/fragments/{id}/…`): the call is a request;
//   - `unavailable`: the project (or the caller) is not active: `ServiceUnavailableError`, at once.
//
// Contracts between fragments carry only structured-cloneable values and streams, whatever the
// placement, so a binding behaves the same when a fragment moves: a function, an `RpcTarget` or a
// stub is refused in every placement, with an error naming the call. A request carries the values
// (V8 serialization) and at most one ReadableStream after them; so does its answer.
import { deserializeError, serializeError } from "@statewalker/webrun-streams";
import { isRpcTarget } from "../core/durable-object.js";
import { asyncStub, entrypointStub, isClassHandle, REFUSE, STUB } from "../core/handles.js";
import type { CellRuntime, WorkerModule } from "../core/runtime.js";
import { H, type Send, withScheme } from "../transport/cells-link.js";
import { v8Codec } from "../v8/codec.js";

/** A call through a binding whose project is not active (removed, never added, or unreachable). */
export class ServiceUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    // An own `name`, so it survives the error's trip back over a link.
    Object.defineProperty(this, "name", { value: "ServiceUnavailableError", enumerable: true });
  }
}

/** Where a binding's call runs: see the module's comment. */
export type ServicePlacement =
  | { readonly kind: "runtime"; readonly runtime: CellRuntime }
  | { readonly kind: "link"; readonly send: Send }
  | { readonly kind: "unavailable"; readonly reason: string };

/** The host's answer for a binding's `service`, asked per call. */
export type ServiceResolver = (service: string) => ServicePlacement | Promise<ServicePlacement>;

/** A binding as the configuration declares it. */
export interface ServiceBindingConfig {
  readonly binding: string;
  readonly service: string;
  readonly entrypoint?: string;
  readonly props?: unknown;
}

// The entrypoints of each project runtime: its module and env, set by `createProjectRuntime`.
const projects = new WeakMap<CellRuntime, { module: WorkerModule; env: unknown }>();

/** Records a project runtime's Worker module, so bindings and links can reach its entrypoints. */
export function registerProjectEntrypoints(
  runtime: CellRuntime,
  module: WorkerModule,
  env: unknown,
): void {
  projects.set(runtime, { module, env });
}

/** A stub of a project runtime's entrypoint (`undefined`: its default export), with `props`. */
function entrypointOf(
  runtime: CellRuntime,
  entrypoint: string | undefined,
  props: unknown,
): Record<string, any> {
  const project = projects.get(runtime);
  if (!project) throw new Error("not a project runtime: it has no entrypoints");
  const target = entrypoint ? project.module[entrypoint] : project.module.default;
  if (!target || entrypoint === "default")
    throw new Error(
      entrypoint
        ? `the project exports no entrypoint "${entrypoint}"`
        : "the project has no default export",
    );
  return entrypointStub(target, project.env, props, runtime.exports);
}

/** `services[B] → "s"` and the method: how errors name a call. */
const callName = (b: ServiceBindingConfig, method: string) =>
  `services[${b.binding}] → "${b.service}"${b.entrypoint ? ` ${b.entrypoint}` : ""}.${method}()`;

const refuse = (what: string, path: string, call: string) => {
  const e = new DOMException(
    `${call}: ${path} is ${what}; only structured-cloneable values and streams cross between fragments`,
    "DataCloneError",
  );
  return Object.defineProperty(e, "name", { value: e.name, enumerable: true });
};

const NativeReadableStream = globalThis.ReadableStream;
const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;

/**
 * Checks what crosses between fragments: refuses functions, `RpcTarget`s, stubs and class
 * handles, Requests and Responses (their bodies cross as streams), and more than one stream.
 * Returns the stream, if any.
 */
export function checkContract(
  value: unknown,
  path: string,
  call: string,
): ReadableStream | undefined {
  let stream: ReadableStream | undefined;
  const walk = (v: unknown, at: string): void => {
    if (v === null || (typeof v !== "object" && typeof v !== "function")) return;
    const refused = (v as Record<symbol, unknown>)[REFUSE];
    if (typeof refused === "string") throw refuse("not serializable", at, call);
    if (typeof v === "function") {
      if ((v as unknown as Record<symbol, unknown>)[STUB] === true)
        throw refuse("a stub", at, call);
      throw refuse("a function", at, call);
    }
    if ((v as Record<symbol, unknown>)[STUB] === true) throw refuse("a stub", at, call);
    if (isRpcTarget(v)) throw refuse("an RpcTarget", at, call);
    if (isClassHandle(v)) throw refuse("a class handle", at, call);
    if (v instanceof NativeRequest || v instanceof NativeResponse)
      throw refuse(
        `a ${v instanceof NativeRequest ? "Request" : "Response"} (pass its body as a stream)`,
        at,
        call,
      );
    if (v instanceof NativeReadableStream) {
      if (stream) throw refuse("a second stream (one stream per call and per answer)", at, call);
      stream = v;
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        walk(x, `${at}[${i}]`);
      });
      return;
    }
    if (Object.getPrototypeOf(v) === Object.prototype)
      for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
    if (v instanceof Map)
      for (const [k, x] of v) {
        walk(k, `${at} key`);
        walk(x, `${at}.get(…)`);
      }
    if (v instanceof Set) for (const x of v) walk(x, `${at} entry`);
  };
  walk(value, path);
  return stream;
}

// On a link: [4-byte length][V8 values][the stream's bytes]. The stream's place in the values
// is a marker object.
const MARK = "$cellbStream";

function replaceStream(v: unknown, stream: ReadableStream): unknown {
  if (v === stream) return { [MARK]: 0 };
  if (Array.isArray(v)) return v.map((x) => replaceStream(x, stream));
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceStream(x, stream)]));
  if (v instanceof Map)
    return new Map([...v].map(([k, x]) => [replaceStream(k, stream), replaceStream(x, stream)]));
  if (v instanceof Set) return new Set([...v].map((x) => replaceStream(x, stream)));
  return v;
}

function restoreStream(v: unknown, stream: ReadableStream): unknown {
  if (v && typeof v === "object") {
    if (Object.getPrototypeOf(v) === Object.prototype) {
      const o = v as Record<string, unknown>;
      if (Object.keys(o).length === 1 && o[MARK] === 0) return stream;
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, restoreStream(x, stream)]));
    }
    if (Array.isArray(v)) return v.map((x) => restoreStream(x, stream));
    if (v instanceof Map)
      return new Map([...v].map(([k, x]) => [restoreStream(k, stream), restoreStream(x, stream)]));
    if (v instanceof Set) return new Set([...v].map((x) => restoreStream(x, stream)));
  }
  return v;
}

/** The values (and their stream) as a body: the values first, then the stream's bytes. */
function encodeFrame(value: unknown, stream: ReadableStream | undefined, call: string): BodyInit {
  let bytes: Uint8Array;
  try {
    bytes = v8Codec.encode(stream ? replaceStream(value, stream) : value);
  } catch (err) {
    const e = new DOMException(`${call}: ${(err as Error)?.message ?? err}`, "DataCloneError");
    throw Object.defineProperty(e, "name", { value: e.name, enumerable: true });
  }
  const head = new Uint8Array(4 + bytes.length);
  new DataView(head.buffer).setUint32(0, bytes.length);
  head.set(bytes, 4);
  if (!stream) return head as BodyInit;
  const reader = stream.getReader();
  let sent = false;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (!sent) {
        sent = true;
        c.enqueue(head);
        return;
      }
      const { done, value: chunk } = await reader.read();
      if (done) c.close();
      else c.enqueue(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer));
    },
    cancel: (why) => reader.cancel(why),
  });
}

/** A body written by `encodeFrame`: its values, with the stream back in its place. */
async function decodeFrame(body: ReadableStream<Uint8Array> | null): Promise<unknown> {
  if (!body) throw new Error("an empty answer on a service link");
  const reader = body.getReader();
  let buf = new Uint8Array(0);
  const need = async (n: number) => {
    while (buf.length < n) {
      const { done, value } = await reader.read();
      if (done) throw new Error("a service link's message ended early");
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    }
  };
  await need(4);
  const length = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);
  await need(4 + length);
  const value = v8Codec.decode(buf.subarray(4, 4 + length));
  const rest = buf.subarray(4 + length);
  if (!hasMark(value)) {
    reader.releaseLock();
    return value;
  }
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      if (rest.length) c.enqueue(rest);
    },
    async pull(c) {
      const { done, value: chunk } = await reader.read();
      if (done) c.close();
      else c.enqueue(chunk);
    },
    cancel: (why) => reader.cancel(why),
  });
  return restoreStream(value, stream);
}

function hasMark(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some(hasMark);
  if (v instanceof Map) return [...v].some(([k, x]) => hasMark(k) || hasMark(x));
  if (v instanceof Set) return [...v].some(hasMark);
  if (Object.getPrototypeOf(v) !== Object.prototype) return false;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length === 1 && o[MARK] === 0) return true;
  return Object.values(o).some(hasMark);
}

/** The request kinds of a service link. */
const SERVICE_RPC = "service-rpc";
const SERVICE_FETCH = "service-fetch";

/**
 * A service binding: `fetch` and JS RPC on the target project's entrypoint, wherever `resolve`
 * places it at the time of each call.
 */
export function serviceBinding(
  config: ServiceBindingConfig,
  resolve: ServiceResolver,
): Record<string, any> {
  const where = async (
    method: string,
  ): Promise<ServicePlacement & { kind: "runtime" | "link" }> => {
    let placement: ServicePlacement;
    try {
      placement = await resolve(config.service);
    } catch (err) {
      throw new ServiceUnavailableError(`${callName(config, method)}: ${(err as Error)?.message}`, {
        cause: err,
      });
    }
    if (placement.kind === "unavailable")
      throw new ServiceUnavailableError(`${callName(config, method)}: ${placement.reason}`);
    return placement;
  };
  const props = config.props ?? {};
  return asyncStub(
    async (method, args) => {
      const call = callName(config, method);
      const stream = checkContract(args, "the arguments", call);
      const placement = await where(method);
      if (placement.kind === "runtime") {
        const result = await entrypointOf(placement.runtime, config.entrypoint, props)[method](
          ...args,
        );
        checkContract(result, "the result", call);
        return result;
      }
      const body = encodeFrame(args, stream, call);
      const res = await sendOver(
        placement.send,
        new Request("http://cellb.internal/", {
          method: "POST",
          headers: { [H.kind]: SERVICE_RPC, ...linkHeaders(config, method) },
          body,
          ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
        } as RequestInit),
        call,
      );
      return decodeFrame(res.body);
    },
    async (req) => {
      const placement = await where("fetch");
      if (placement.kind === "runtime")
        return entrypointOf(placement.runtime, config.entrypoint, props).fetch(req);
      const headers = new Headers(req.headers);
      for (const [k, v] of Object.entries(linkHeaders(config))) headers.set(k, v);
      headers.set(H.kind, SERVICE_FETCH);
      headers.set(H.serviceUrl, req.url);
      return sendOver(
        placement.send,
        new Request("http://cellb.internal/", {
          method: req.method,
          headers,
          body: req.body,
          signal: null,
          ...(req.body ? { duplex: "half" } : {}),
        } as RequestInit),
        callName(config, "fetch"),
      );
    },
  );
}

function linkHeaders(config: ServiceBindingConfig, method?: string): Record<string, string> {
  return {
    [H.entrypoint]: config.entrypoint ?? "",
    [H.props]: encodeURIComponent(JSON.stringify(config.props ?? {})),
    ...(method ? { [H.method]: method } : {}),
  };
}

/**
 * Sends one call over a link. A link that cannot be reached, or an answer that did not come from
 * a project's service handler (a shard or host without the fragment), is `ServiceUnavailableError`;
 * an error the call threw comes back as itself.
 */
async function sendOver(send: Send, req: Request, call: string): Promise<Response> {
  let res: Response;
  try {
    res = await send(withScheme(req));
  } catch (err) {
    throw new ServiceUnavailableError(`${call}: ${(err as Error)?.message ?? err}`, { cause: err });
  }
  const kind = res.headers.get(H.kind);
  if (kind === "error") {
    const err = deserializeError(await res.json()) as Error;
    if (err?.name === "ServiceUnavailableError")
      throw new ServiceUnavailableError(err.message, { cause: err });
    throw err;
  }
  if (kind !== "service") {
    const text = await res.text().catch(() => "");
    throw new ServiceUnavailableError(
      `${call}: the link answered ${res.status}${text ? ` (${text.slice(0, 200)})` : ""}`,
    );
  }
  // The answer as the entrypoint gave it: without the marker.
  const headers = new Headers(res.headers);
  headers.delete(H.kind);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Whether a request on a link is a service call (`serveServiceCall` answers it). */
export function isServiceCall(req: Request): boolean {
  const kind = req.headers.get(H.kind);
  return kind === SERVICE_RPC || kind === SERVICE_FETCH;
}

/** An error as the caller gets it back: its name too (a RangeError stays one by name). */
const errorAnswer = (e: unknown, status = 500) =>
  Response.json(
    { ...serializeError(e), ...(e instanceof Error ? { name: e.name } : {}) },
    { status, headers: { [H.kind]: "error" } },
  );

/**
 * The far side of a link: runs a service call (`isServiceCall`) on `runtime`'s entrypoint and
 * answers it. `runtime` undefined: the project is not here (`ServiceUnavailableError`).
 */
export async function serveServiceCall(
  req: Request,
  runtime: CellRuntime | undefined,
  why = "the fragment is not active here",
): Promise<Response> {
  const kind = req.headers.get(H.kind);
  const entrypoint = req.headers.get(H.entrypoint) || undefined;
  const method = req.headers.get(H.method) ?? "";
  const call = `${entrypoint ?? "default"}.${kind === SERVICE_FETCH ? "fetch" : method}()`;
  try {
    if (!runtime) throw new ServiceUnavailableError(`${call}: ${why}`);
    let props: unknown = {};
    try {
      props = JSON.parse(decodeURIComponent(req.headers.get(H.props) ?? "%7B%7D"));
    } catch {
      throw new Error("invalid service props");
    }
    const target = entrypointOf(runtime, entrypoint, props);
    if (kind === SERVICE_FETCH) {
      const url = req.headers.get(H.serviceUrl);
      if (!url) throw new Error("a service fetch without its url");
      const headers = new Headers(req.headers);
      for (const h of Object.values(H)) headers.delete(h);
      const inner = new Request(url, {
        method: req.method,
        headers,
        body: req.body,
        ...(req.body ? { duplex: "half" } : {}),
      } as RequestInit);
      const res = (await target.fetch(inner)) as Response;
      const out = new Headers(res.headers);
      out.set(H.kind, "service");
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: out,
      });
    }
    const args = (await decodeFrame(req.body)) as unknown[];
    if (!Array.isArray(args)) throw new Error("a service call without its arguments");
    const result = await target[method](...args);
    const stream = checkContract(result, "the result", call);
    return new Response(encodeFrame(result, stream, call), {
      headers: { [H.kind]: "service", "content-type": "application/x-cellb-values" },
    });
  } catch (e) {
    return errorAnswer(e, e instanceof ServiceUnavailableError ? 503 : 500);
  }
}
