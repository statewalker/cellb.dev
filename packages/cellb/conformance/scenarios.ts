/**
 * Request scripts for the celld examples (conformance/celld-examples). The same script runs
 * against celld (recorded into golden/) and against webrun-cells; transcripts must match.
 * Steps run sequentially. Fields named in `mask` (anywhere in JSON bodies) are replaced by
 * their type, because they hold times or generated ids that differ between runs.
 */
export type Step =
  | { method?: string; path: string; body?: string; headers?: Record<string, string> }
  | { waitMs: number }
  | { ws: string; send: string[]; receive: number };

export interface Scenario {
  steps: Step[];
  mask?: string[];
}

const json = { "content-type": "application/json" };

export const scenarios: Record<string, Scenario> = {
  hello: { steps: [{ path: "/" }, { path: "/a/b?x=1" }] },
  webapi: { steps: [{ path: "/p/q?foo=bar&x=1" }] },
  counter: {
    steps: [
      { path: "/increment?name=alpha" },
      { path: "/increment?name=alpha" },
      { path: "/increment?name=beta" },
      { path: "/?name=alpha" },
    ],
  },
  kv: {
    steps: [
      { path: "/greeting" },
      { method: "PUT", path: "/greeting", body: "hello" },
      { path: "/greeting" },
      { method: "PUT", path: "/greeting", body: "hello again ✓" },
      { path: "/greeting" },
      { method: "DELETE", path: "/greeting" },
      { path: "/greeting" },
      { path: "/" },
    ],
  },
  d1: {
    steps: [
      { path: "/count" },
      { method: "POST", path: "/", body: JSON.stringify({ name: "ada", message: "hi" }), headers: json },
      { method: "POST", path: "/", body: JSON.stringify({ name: "alan", message: "hello" }), headers: json },
      { path: "/count" },
      { path: "/" },
    ],
    mask: ["at"],
  },
  rpc: { steps: [{ path: "/" }, { method: "POST", path: "/" }, { method: "POST", path: "/" }, { path: "/" }] },
  router: { steps: [{ path: "/a" }, { path: "/a" }, { path: "/b" }, { path: "/" }] },
  body: {
    steps: [
      { method: "POST", path: "/x", body: JSON.stringify({ n: 2, tag: "two" }), headers: json },
      { method: "PUT", path: "/x", body: JSON.stringify({ n: 3 }), headers: json },
      { method: "DELETE", path: "/x", body: "abcdef" },
      { path: "/y" },
    ],
  },
  async: { steps: [{ path: "/" }, { path: "/" }, { path: "/" }] },
  alarm: {
    steps: [{ path: "/" }, { path: "/arm" }, { path: "/" }, { waitMs: 3500 }, { path: "/" }],
    mask: ["at", "pendingAlarm"],
  },
  wsecho: {
    steps: [{ path: "/" }, { ws: "/", send: ["one", "two"], receive: 2 }, { ws: "/", send: ["three"], receive: 1 }],
  },
  queues: { steps: [{ path: "/job-1" }], mask: ["createdAt"] },
  r2: {
    steps: [
      { path: "/notes.txt" },
      { method: "PUT", path: "/notes.txt", body: "hello r2", headers: { "content-type": "text/plain" } },
      { path: "/notes.txt" },
      { method: "DELETE", path: "/notes.txt" },
      { path: "/notes.txt" },
    ],
  },
  facets: { steps: [{ path: "/" }, { path: "/" }] },
};

export interface Exchange {
  request: string;
  status?: number;
  contentType?: string | null;
  body?: unknown;
  messages?: unknown[];
}

/** Replaces masked JSON fields by their type, and the origin by a placeholder. */
export function normalize(text: string, origin: string, mask: string[] = []): unknown {
  const t = text.split(origin).join("{origin}").split(new URL(origin).host).join("{host}");
  let value: unknown;
  try {
    value = JSON.parse(t);
  } catch {
    return t;
  }
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, mask.includes(k) ? `<${x === null ? "null" : typeof x}>` : walk(x)]),
      );
    return v;
  };
  return walk(value);
}

export interface Target {
  origin: string;
  fetch(req: Request): Promise<Response>;
  /** Opens a WebSocket to `url` and returns a minimal client. */
  websocket(url: string): Promise<{ send(m: string): void; next(): Promise<unknown>; close(): void }>;
}

/** Runs one scenario against a target and returns the normalized transcript. */
export async function runScenario(target: Target, s: Scenario): Promise<Exchange[]> {
  const out: Exchange[] = [];
  for (const step of s.steps) {
    if ("waitMs" in step) {
      await new Promise((r) => setTimeout(r, step.waitMs));
      continue;
    }
    if ("ws" in step) {
      const ws = await target.websocket(`${target.origin.replace(/^http/, "ws")}${step.ws}`);
      const messages: unknown[] = [];
      for (const m of step.send) ws.send(m);
      for (let i = 0; i < step.receive; i++) messages.push(normalize(String(await ws.next()), target.origin, s.mask));
      ws.close();
      out.push({ request: `WS ${step.ws} ${JSON.stringify(step.send)}`, messages });
      continue;
    }
    const method = step.method ?? "GET";
    const res = await target.fetch(
      new Request(`${target.origin}${step.path}`, { method, body: step.body, headers: step.headers }),
    );
    out.push({
      request: `${method} ${step.path}`,
      status: res.status,
      contentType: res.headers.get("content-type"),
      body: normalize(await res.text(), target.origin, s.mask),
    });
  }
  return out;
}
