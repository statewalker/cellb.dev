/**
 * Isolation for loaded Workers (celld runs each in its own V8 isolate): the loaded code runs
 * in a separate realm — a worker thread on Node, a Dedicated Worker in browsers — and talks
 * to the host over one MessagePort. The host keeps everything else: bindings in the loaded
 * Worker's env are reached through stubs, and its logs come back for Tail Workers.
 *
 *   host → isolate   load {source|url, plain env, stub names, outbound}   → loaded {exports}
 *                    fetch {name, request}                                → response
 *                    call {name, method, args}                            → result
 *   isolate → host   stub {key, method, args}                             → result
 *                    log {level, args}
 */
export interface PortLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener?(type: "message", fn: (e: { data: unknown }) => void): void;
  on?(type: "message", fn: (data: unknown) => void): void;
  start?(): void;
}

export interface SerializedRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}
export interface SerializedResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}

export async function serializeRequest(req: Request): Promise<SerializedRequest> {
  return {
    url: req.url,
    method: req.method,
    headers: [...req.headers],
    body: req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer(),
  };
}
export const deserializeRequest = (r: SerializedRequest) =>
  new Request(r.url, { method: r.method, headers: r.headers, body: r.body });
export async function serializeResponse(res: Response): Promise<SerializedResponse> {
  return {
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers],
    body: res.body ? await res.arrayBuffer() : null,
  };
}
export const deserializeResponse = (r: SerializedResponse) =>
  new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers });

/** Request/response over a port, both directions (each side answers the other's calls). */
export function rpcPort(port: PortLike, handle: (msg: any) => Promise<unknown>) {
  let next = 0;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();
  const onMessage = async (m: any) => {
    if (m?.reply !== undefined) {
      const p = pending.get(m.reply);
      pending.delete(m.reply);
      if (m.error) {
        const e = new Error(m.error.message);
        e.name = m.error.name;
        p?.reject(e);
      } else p?.resolve(m.value);
      return;
    }
    if (m?.id === undefined) return void handle(m).catch(() => {}); // one-way (logs)
    try {
      port.postMessage({ reply: m.id, value: await handle(m) });
    } catch (e) {
      port.postMessage({
        reply: m.id,
        error: { name: (e as Error)?.name ?? "Error", message: String((e as Error)?.message ?? e) },
      });
    }
  };
  if (port.on) port.on("message", onMessage);
  else {
    port.addEventListener!("message", (e) => onMessage(e.data));
    port.start?.();
  }
  return {
    request<T>(msg: object): Promise<T> {
      const id = ++next;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        port.postMessage({ ...msg, id });
      });
    },
    send(msg: object): void {
      port.postMessage(msg);
    },
  };
}

/** Plain (structured-cloneable) env values travel; anything else becomes a stub by key. */
export function splitEnv(env: Record<string, unknown>): {
  plain: Record<string, unknown>;
  stubs: string[];
} {
  const plain: Record<string, unknown> = {};
  const stubs: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    try {
      if (typeof v === "function") throw new Error("function");
      plain[k] = structuredClone(v);
    } catch {
      stubs.push(k);
    }
  }
  return { plain, stubs };
}
