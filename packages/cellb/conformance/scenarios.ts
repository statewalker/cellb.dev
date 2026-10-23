import wdProjects from "./workerd-tests/projects.json" with { type: "json" };

/**
 * Request scripts for the celld examples (conformance/celld-examples). The same script runs
 * against celld (recorded into golden/) and against webrun-cells; transcripts must match.
 * Steps run sequentially. Fields named in `mask` (anywhere in JSON bodies) are replaced by
 * their type, because they hold times or generated ids that differ between runs.
 */
export type Step =
  | {
      method?: string;
      path: string;
      body?: string;
      headers?: Record<string, string>;
      ifNoneMatchPrevious?: boolean;
    }
  | { waitMs: number }
  | { ws: string; send: string[]; receive: number };

export interface Scenario {
  steps: Step[];
  mask?: string[];
  /** Compare what user code logs (celld: `cell_console:` lines of `celld dev --logs`). */
  logs?: boolean;
  /** Regex → replacement applied to each log line (volatile values). */
  logMask?: [string, string][];
  /** Time to wait after the last step before collecting logs (default 1500 ms). */
  settleMs?: number;
  /** Start a reference WebSocket server; `{wsserver}` in paths becomes its ws:// origin. */
  wsServer?: boolean;
  /** Response headers to record (lower case), besides content-type. */
  headers?: string[];
  /** Regex → replacement applied to every response text before parsing (e.g. stack frames). */
  textMask?: [string, string][];
  /** Project directory name when it differs from the scenario name. */
  project?: string;
  /** A recorded celld behaviour webrun-cells does not reproduce yet (tests expect a mismatch). */
  knownGap?: string;
  /** Keep each distinct log line once (periodic events whose count depends on timing). */
  uniqueLogs?: boolean;
}

/** Formats console arguments as celld prints them: strings raw, other values as JSON. */
export function formatLog(args: unknown[]): string {
  return args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
}

/** Masks, then sorts log lines (celld gives no ordering guarantee across events). */
export function normalizeLogs(lines: string[], s: Scenario): string[] {
  return lines
    .map((l) =>
      (s.logMask ?? []).reduce((acc, [re, by]) => acc.replace(new RegExp(re, "g"), by), l),
    )
    .filter((l, i, all) => !s.uniqueLogs || all.indexOf(l) === i)
    .sort();
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
      {
        method: "POST",
        path: "/",
        body: JSON.stringify({ name: "ada", message: "hi" }),
        headers: json,
      },
      {
        method: "POST",
        path: "/",
        body: JSON.stringify({ name: "alan", message: "hello" }),
        headers: json,
      },
      { path: "/count" },
      { path: "/" },
    ],
    mask: ["at"],
  },
  rpc: {
    steps: [
      { path: "/" },
      { method: "POST", path: "/" },
      { method: "POST", path: "/" },
      { path: "/" },
    ],
  },
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
    steps: [
      { path: "/" },
      { ws: "/", send: ["one", "two"], receive: 2 },
      { ws: "/", send: ["three"], receive: 1 },
    ],
  },
  queues: {
    steps: [{ path: "/job-1" }, { path: "/job-2/fail" }],
    mask: ["createdAt"],
    logs: true,
    settleMs: 25_000,
    logMask: [['"createdAt":"[^"]+"', '"createdAt":"<date>"']],
  },
  "dynamic-worker-tails": { steps: [{ path: "/" }, { path: "/again" }], logs: true },
  workflow: {
    steps: [
      { path: "/create?url={httpserver}/text/3" },
      { waitMs: 3000 },
      { path: "/status?id={prev.id}" },
    ],
    wsServer: true,
    mask: ["id"],
  },
  vectordb: {
    steps: [
      { path: "/255,0,0" },
      { method: "PUT", path: "/red", body: "[255,0,0]" },
      { method: "PUT", path: "/navy", body: "[0,0,128]" },
      { method: "PUT", path: "/light%20green", body: "[144,238,144]" },
      { path: "/250,10,5" },
      { path: "/10,10,120" },
      { path: "/150,230,150" },
      { path: "/300,0,0" },
    ],
  },
  wsclient: {
    steps: [
      { path: "/" },
      { path: "/connect?url={wsserver}/room/c1" },
      { waitMs: 1500 },
      { path: "/" },
    ],
    wsServer: true,
  },
  cron: {
    steps: [{ path: "/" }, { waitMs: 65_000 }],
    logs: true,
    uniqueLogs: true,
    logMask: [["cron \\d+", "cron <scheduledTime>"]],
  },
  r2: {
    steps: [
      { path: "/notes.txt" },
      {
        method: "PUT",
        path: "/notes.txt",
        body: "hello r2",
        headers: { "content-type": "text/plain" },
      },
      { path: "/notes.txt" },
      { method: "DELETE", path: "/notes.txt" },
      { path: "/notes.txt" },
    ],
  },
  facets: { steps: [{ path: "/" }, { path: "/" }] },
  // conformance/projects (ours): API coverage beyond celld's examples.
  "queues-api": {
    steps: [{ path: "/errors" }, { path: "/send" }, { waitMs: 8000 }, { path: "/log" }],
  },
  "static-assets": {
    steps: [
      { path: "/" },
      { path: "/home" },
      { path: "/index.html" },
      { path: "/nope" },
      { method: "HEAD", path: "/" },
    ],
    headers: ["x-served-by", "location", "cache-control", "content-length", "etag"],
  },
  "assets-api": {
    steps: [
      { path: "/" },
      { path: "/", ifNoneMatchPrevious: true },
      { path: "/about" },
      { path: "/about.html" },
      { path: "/about/" },
      { path: "/docs" },
      // "/docs/" omitted: celld 0.6.2 does not serve nested index files (bug; see note 18).
      { path: "/style.css" },
      { path: "/data.unknownext", headers: { range: "bytes=2-5" } },
      { path: "/data.unknownext", headers: { range: "bytes=50-60" } },
      { path: "/old-about" },
      { path: "/temp" },
      { path: "/alias" },
      { path: "/blog/x" },
      { path: "/api/items" },
      { path: "/via-binding" },
      { path: "/missing", headers: { accept: "text/html" } },
      { path: "/missing.json" },
      { method: "POST", path: "/about" },
    ],
    headers: [
      "x-served-by",
      "x-docs",
      "location",
      "cache-control",
      "content-length",
      "content-range",
      "etag",
    ],
  },
  "workflow-api": {
    steps: [
      { path: "/create?id=s1&kind=steps" },
      { path: "/create?id=e1&kind=event" },
      { path: "/create?id=r1&kind=retry" },
      { path: "/create?id=r2&kind=retry2" },
      { path: "/create?id=f1&kind=fail" },
      { path: "/create?id=l1&kind=long" },
      { waitMs: 300 },
      // (no mid-sleep check of s1: timing-dependent on a loaded machine; l1 covers "waiting")

      { path: "/status?id=e1" },
      { path: "/status?id=l1" },
      { path: "/event?id=e1" },
      { path: "/terminate?id=l1" },
      { waitMs: 3000 },
      { path: "/status?id=s1" },
      { path: "/status?id=e1" },
      { path: "/status?id=r1" },
      { path: "/status?id=r2" },
      { path: "/status?id=f1" },
      { path: "/status?id=l1" },
      { path: "/delete?id=s1" },
      { path: "/create?id=d1&kind=long" },
      { path: "/create?id=d2&kind=long" },
      { path: "/delete-batch?ids=d1,d2" },
    ],
  },
  "facets-api": {
    steps: [
      "a",
      "a",
      "a-fetch",
      "b",
      "abort-a",
      "a",
      "delete-b",
      "b",
      "local",
      "calc",
      "greet",
    ].map((op) => ({
      path: `/${op}`,
    })),
  },
  "runtime-api": {
    steps: [
      { path: "/cache" },
      { path: "/self" },
      { path: "/math" },
      { path: "/kv" },
      { path: "/load" },
      { ws: "/room?name=ada", send: ["one", "two"], receive: 2 },
    ],
  },
  "r2-advanced": { steps: [{ path: "/conditional" }, { path: "/multipart" }] },
  "html-rewriter": { steps: [{ path: "/" }] },
  "html-rewriter-async": {
    project: "html-rewriter",
    steps: [{ path: "/async" }],
  },
  "node-compat": { steps: [{ path: "/" }] },
  "assets-force": {
    steps: // "/about/" and "/docs/" omitted: celld 0.6.2 answers 404 for every path ending in "/"
      // except the root (bug; see note 18) — unit-tested against Cloudflare's behaviour instead.
      [
        "/",
        "/index.html",
        "/about",
        "/about.html",
        "/docs",
        "/docs/index.html",
        "/secret.txt",
        "/notes.md",
        "/nope",
      ].map((path) => ({ path })),
    headers: ["location"],
  },
  "assets-drop": {
    steps: // "/about/" and "/docs/" omitted: celld 0.6.2 answers 404 for every path ending in "/"
      // except the root (bug; see note 18) — unit-tested against Cloudflare's behaviour instead.
      [
        "/",
        "/index.html",
        "/about",
        "/about.html",
        "/docs",
        "/docs/index.html",
        "/secret.txt",
        "/notes.md",
        "/nope",
      ].map((path) => ({ path })),
    headers: ["location"],
  },
  "isolation-api": { steps: [{ path: "/" }, { path: "/facet" }] },
  "d1-details": { steps: [{ path: "/session" }, { path: "/refused" }, { path: "/pitr" }] },
  "do-ids": { steps: [{ path: "/" }], mask: ["uniqueId"] },
  "kv-details": { steps: [{ path: "/" }] },
  "storage-details": {
    steps: [{ path: "/kv" }, { path: "/sql" }, { path: "/txn" }, { path: "/alarms" }],
  },
  "queues-details": {
    steps: [{ path: "/validate" }, { path: "/send" }, { waitMs: 3500 }, { path: "/log" }],
    mask: ["oldestMessageTimestamp"],
  },
  // etag/version are celld dev-mode store generations; uploaded is a clock reading
  "r2-details": { steps: [{ path: "/" }], mask: ["etag", "httpEtag", "version", "uploaded"] },
  "worker-details": {
    steps: ["/throw", "/not-response", "/rpc", "/cf", "/headers", "/redirect", "/passthrough"].map(
      (path) => ({ path }),
    ),
    headers: ["location", "set-cookie", "x-multi"],
    // stack frames point into each engine's own bundle
    textMask: [[" \\[at [^\\]]*\\]", ""]],
  },
  "ws-details": {
    steps: [
      { ws: "/?tag=red", send: ["hello", "ping", "info"], receive: 3 },
      { path: "/no-upgrade" },
      { path: "/pair" },
    ],
  },
  "kv-values": { steps: [{ path: "/write" }, { path: "/read" }] },
  "alarm-retry": { steps: [{ path: "/arm?in=300" }, { waitMs: 9000 }, { path: "/" }] },
  "r2-api": {
    steps: ["put", "head", "get", "range", "json", "list", "delete"].map((s) => ({
      path: `/${s}`,
    })),
    // celld's ETag (dev mode: a store generation number, "16") is not R2's MD5: compared by type only.
    mask: ["etag", "httpEtag"],
  },
};

// workerd's own Durable Object tests, unchanged (conformance/workerd-tests, generated by
// scripts/vendor-workerd-tests.mjs): GET / runs every `test` export inside the worker and
// answers each one's outcome. Per-project adjustments (knownGap, textMask, …) go here.
const wdOverrides: Record<string, Partial<Scenario>> = {};
for (const name of wdProjects as string[])
  scenarios[name] = { steps: [{ path: "/" }], ...wdOverrides[name] };

export interface Exchange {
  request: string;
  headers?: Record<string, string | null>;
  status?: number;
  contentType?: string | null;
  body?: unknown;
  messages?: unknown[];
}

/** Replaces masked JSON fields by their type, and the origin by a placeholder. */
export function normalize(
  text: string,
  origin: string,
  mask: string[] = [],
  textMask: [string, string][] = [],
): unknown {
  const t = textMask.reduce(
    (acc, [re, by]) => acc.replace(new RegExp(re, "g"), by),
    text.split(origin).join("{origin}").split(new URL(origin).host).join("{host}"),
  );
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
        Object.entries(v).map(([k, x]) => [
          k,
          mask.includes(k) ? `<${x === null ? "null" : typeof x}>` : walk(x),
        ]),
      );
    return v;
  };
  return walk(value);
}

export interface Target {
  origin: string;
  /** ws:// origin of the reference WebSocket server, when the scenario asks for one. */
  wsServer?: string;
  fetch(req: Request): Promise<Response>;
  /** Opens a WebSocket to `url` and returns a minimal client. */
  websocket(
    url: string,
  ): Promise<{ send(m: string): void; next(): Promise<unknown>; close(): void }>;
}

/** Runs one scenario against a target and returns the normalized transcript. */
export async function runScenario(target: Target, s: Scenario): Promise<Exchange[]> {
  const out: Exchange[] = [];
  let lastEtag: string | undefined;
  let lastJson: unknown;
  for (const step of s.steps) {
    if ("waitMs" in step) {
      await new Promise((r) => setTimeout(r, step.waitMs));
      continue;
    }
    if ("ws" in step) {
      const ws = await target.websocket(`${target.origin.replace(/^http/, "ws")}${step.ws}`);
      const messages: unknown[] = [];
      for (const m of step.send) ws.send(m);
      for (let i = 0; i < step.receive; i++)
        messages.push(normalize(String(await ws.next()), target.origin, s.mask));
      ws.close();
      out.push({ request: `WS ${step.ws} ${JSON.stringify(step.send)}`, messages });
      continue;
    }
    const method = step.method ?? "GET";
    const path = step.path
      .replace("{wsserver}", encodeURIComponent(target.wsServer ?? ""))
      .replace("{httpserver}", encodeURIComponent((target.wsServer ?? "").replace(/^ws/, "http")))
      .replace(/\{prev\.(\w+)\}/g, (_, k) =>
        encodeURIComponent(String((lastJson as Record<string, unknown>)?.[k] ?? "")),
      );
    const reqHeaders = new Headers(step.headers);
    if (step.ifNoneMatchPrevious && lastEtag) reqHeaders.set("if-none-match", lastEtag);
    const res = await target.fetch(
      new Request(`${target.origin}${path}`, {
        redirect: "manual",
        method,
        body: step.body,
        headers: reqHeaders,
      }),
    );
    lastEtag = res.headers.get("etag") ?? lastEtag;
    const text = await res.clone().text();
    try {
      lastJson = JSON.parse(text);
    } catch {
      lastJson = undefined;
    }
    out.push({
      request: `${method} ${step.path}`,
      ...(s.headers
        ? {
            headers: Object.fromEntries(
              s.headers.map((h) => [h, normalizeHeader(h, res.headers.get(h), target.origin)]),
            ),
          }
        : {}),
      status: res.status,
      contentType: res.headers.get("content-type"),
      body: normalize(await res.text(), target.origin, s.mask, s.textMask),
    });
  }
  return out;
}

/** Volatile header values (ETag digests, absolute Location) normalized like bodies. */
function normalizeHeader(name: string, value: string | null, origin: string): string | null {
  if (value === null) return null;
  if (name === "etag")
    return /^(W\/)?"[0-9a-f]{64}"$/.test(value) ? "<sha256-etag>" : `<etag:${value}>`;
  return value.split(origin).join("{origin}");
}

/**
 * Documented difference, not hidden: celld 0.6.2 sends NO Content-Type for
 * `new Response("text")`, while the Fetch standard (browsers, Node, workerd) sets
 * "text/plain;charset=UTF-8". Only that exact pair is aligned.
 */
export function alignDocumentedDifferences(ours: Exchange[], theirs: Exchange[]): Exchange[] {
  return ours.map((e, i) =>
    theirs[i]?.contentType === null && e.contentType === "text/plain;charset=UTF-8"
      ? { ...e, contentType: null }
      : e,
  );
}

/**
 * celld answers through an HTTP server, which sets Content-Length on buffered bodies; an
 * in-process runtime has no wire, so the runner adds it the same way.
 */
export async function withContentLength(req: Request, res: Response): Promise<Response> {
  if (res.headers.has("content-length") || [101, 204, 205, 304].includes(res.status)) return res;
  const body = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  headers.set("content-length", String(body.byteLength));
  return new Response(req.method === "HEAD" ? null : body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Documented browser limitation, not hidden: a Response built in a browser drops Set-Cookie
 * (a forbidden response header), and a ServiceWorker cannot deliver it to a page anyway.
 * Only that header, and only when celld sent one and the browser run has none.
 */
export function alignBrowserDifferences(ours: Exchange[], theirs: Exchange[]): Exchange[] {
  return ours.map((e, i) => {
    const want = theirs[i]?.headers?.["set-cookie"];
    if (!e.headers || want == null || e.headers["set-cookie"] !== null) return e;
    return { ...e, headers: { ...e.headers, "set-cookie": want } };
  });
}
