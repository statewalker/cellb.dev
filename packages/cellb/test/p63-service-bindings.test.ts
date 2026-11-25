// Service bindings between the projects of a fragment host (#192): `services` naming another
// project gives a binding whose transport follows placement. Its fragment DO on this shard: JS RPC
// in the runtime; on another shard: a request over a MessagePort to that shard's link handler;
// on another host: HTTP to `/fragments/{id}/…`. Contracts carry only cloneable values and
// streams, in every placement; a binding to a fragment that is not active fails at once.
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  createFragmentHost,
  type FragmentHost,
  loadProject,
  type ServicePlacement,
  ServiceUnavailableError,
} from "@statewalker/cellb/node";
import { afterEach, describe, expect, test } from "vitest";
import { cellsHttpHandler } from "../src/transport/cells-http.js";
import { linkOverPort, serveHandlerOverPort } from "../src/transport/port.js";

const PKG = resolve(import.meta.dirname, "..");
const GAMMA = join(PKG, "test/fixtures/fragments/gamma");
const DELTA = join(PKG, "test/fixtures/fragments/delta");
const G = "org.example.gamma";
const D = "org.example.delta";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
function host(options?: Parameters<typeof createFragmentHost>[0]): FragmentHost {
  const h = createFragmentHost(options);
  cleanup.push(() => h.close());
  return h;
}

// biome-ignore lint/suspicious/noExplicitAny: bindings are untyped stubs
type Env = Record<string, any>;
const envOf = (h: FragmentHost, id: string) => h.project(id)?.runtime.env as Env;

const text = (s: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const part of s.split(" ")) c.enqueue(new TextEncoder().encode(`${part} `));
      c.close();
    },
  });
const read = (s: ReadableStream<Uint8Array>) => new Response(s).text();

/**
 * What a binding must do in every placement: `env` is the caller's, gamma serves `Api` and a
 * default export.
 */
async function contractChecks(env: Env) {
  expect(await env.API.hello("delta")).toBe('hello delta from gamma, props {"who":"delta"}');
  // The target's own fragment DO, through its entrypoint.
  const first = await env.API.count();
  expect(await env.API.count()).toBe(first + 1);
  // Cloneable values, as structured clone gives them.
  const value = {
    when: new Date(5),
    bytes: new Uint8Array([1, 2, 3]),
    map: new Map([["k", [1, { deep: true }]]]),
    set: new Set(["a"]),
    big: 12n,
    nothing: undefined,
  };
  expect(await env.API.echo(value)).toEqual(value);
  // A stream in, a stream out.
  expect(await read(await env.API.upper(text("one two three")))).toBe("ONE TWO THREE ");
  // A value shaped like the link's own framing stays a value (no stream sent).
  expect(await env.API.echo({ $cellbStream: 0 })).toEqual({ $cellbStream: 0 });
  expect(await env.API.echo([{ $cellbStream: 0 }, { s: text("x") }])).toMatchObject([
    { $cellbStream: 0 },
    { s: expect.any(ReadableStream) },
  ]);
  // A stream crosses inside arrays and plain objects, not inside a Map or Set.
  await expect(env.API.echo(new Map([["s", text("x")]]))).rejects.toMatchObject({
    name: "DataCloneError",
    message: expect.stringContaining("a stream inside a Map or Set"),
  });
  // An error the call throws comes back as itself.
  await expect(env.API.fail()).rejects.toMatchObject({
    name: "RangeError",
    message: "gamma refused",
  });
  // Functions and stubs cross no fragment boundary, in an argument or a result.
  await expect(env.API.echo({ cb: () => 1 })).rejects.toMatchObject({
    name: "DataCloneError",
    message: expect.stringContaining(
      `services[API] → "${G}" Api.echo(): the arguments[0].cb is a function`,
    ),
  });
  await expect(env.API.giveFunction()).rejects.toMatchObject({
    name: "DataCloneError",
    message: expect.stringContaining(`Api.giveFunction(): the result.f is a function`),
  });
  await expect(env.API.echo(env.GAMMA)).rejects.toMatchObject({
    name: "DataCloneError",
    message: expect.stringContaining("the arguments[0] is a stub"),
  });
  await expect(env.API.echo(text("a"), text("b"))).rejects.toMatchObject({
    name: "DataCloneError",
    message: expect.stringContaining("a second stream"),
  });
  await expect(env.API.echo(new Request("http://x/"))).rejects.toMatchObject({
    name: "DataCloneError",
    message: expect.stringContaining("a Request (pass its body as a stream)"),
  });
  // fetch, to the default export: method, path, query, body, status and headers.
  const res = await env.GAMMA.fetch("http://gamma/p?q=1", { method: "POST", body: "hi" });
  expect(res.status).toBe(201);
  expect(res.headers.get("x-from")).toBe("gamma");
  expect(await res.text()).toBe("gamma default POST /p?q=1 hi");
}

describe("service bindings between projects of one fragment host (same shard)", () => {
  test("fetch and JS RPC, with the contract checked", async () => {
    const h = host();
    await h.add(G, GAMMA);
    const delta = await h.add(D, DELTA);
    // No longer reported in a fragment host.
    expect(delta.unsupported.filter((u) => u.startsWith("services"))).toEqual([]);
    await contractChecks(envOf(h, D));
  });

  test("from Worker code: the caller's fragment DO calls through its bindings", async () => {
    const h = host();
    await h.add(G, GAMMA);
    await h.add(D, DELTA);
    const get = async (path: string) =>
      (await h.fetch(new Request(`http://localhost/fragments/${D}${path}`))).text();
    expect(JSON.parse(await get("/hello"))).toBe('hello delta from gamma, props {"who":"delta"}');
    expect(JSON.parse(await get("/count"))).toBe(1);
    expect(await get("/fetch")).toBe("gamma default GET /p?q=1 ");
  });

  test("a project loaded alone still reports services to other scripts", async () => {
    const project = await loadProject(DELTA);
    cleanup.push(() => project.close());
    expect(project.unsupported).toContain(
      `services[API] → "${G}" (only this script's own entrypoints)`,
    );
  });

  test("bindings follow activation: unavailable before, during and after, never hanging", async () => {
    const h = host();
    const delta = await h.add(D, DELTA);
    const env = delta.runtime.env as Env;
    const unavailable = {
      name: "ServiceUnavailableError",
      message: `services[API] → "${G}" Api.hello(): no fragment "${G}" is active on this host`,
    };
    await expect(env.API.hello("x")).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(env.API.hello("x")).rejects.toMatchObject(unavailable);
    await expect(env.GAMMA.fetch("http://gamma/")).rejects.toBeInstanceOf(ServiceUnavailableError);
    await h.add(G, GAMMA);
    expect(await env.API.hello("x")).toContain("hello x");
    await h.remove(G);
    await expect(env.API.hello("x")).rejects.toMatchObject(unavailable);
    // Back again: the same binding reaches it (its data kept).
    await h.add(G, GAMMA);
    expect(await env.API.count()).toBe(1);
    // The caller removed: its bindings are disposed with it.
    await h.remove(D);
    await expect(env.API.hello("x")).rejects.toMatchObject({
      name: "ServiceUnavailableError",
      message: expect.stringContaining(`the calling fragment "${D}" is not active`),
    });
  });
});

describe("service bindings to another shard (a MessagePort link)", () => {
  /** gamma's runtime served as another shard serves it: its link handler over a port. */
  async function otherShard() {
    const gamma = await loadProject(GAMMA);
    cleanup.push(() => gamma.close());
    const { port1, port2 } = new MessageChannel();
    const stop = await serveHandlerOverPort(port2, cellsHttpHandler(gamma.runtime));
    const link = await linkOverPort(port1);
    cleanup.push(async () => {
      await link.close();
      await stop();
      port1.close();
      port2.close();
    });
    return { gamma, link, stop };
  }

  test("fetch and JS RPC, with the contract checked", async () => {
    const { link } = await otherShard();
    const delta = await loadProject(DELTA, {
      services: (s) =>
        s === G ? { kind: "link", send: link.send } : { kind: "unavailable", reason: "none" },
    });
    cleanup.push(() => delta.close());
    expect(delta.unsupported.filter((u) => u.startsWith("services"))).toEqual([]);
    await contractChecks(delta.runtime.env as Env);
  });

  test("a shard that does not hold the fragment, or a lost link, is unavailable", async () => {
    let placement: ServicePlacement = { kind: "unavailable", reason: "x" };
    const delta = await loadProject(DELTA, { services: () => placement });
    cleanup.push(() => delta.close());
    const env = delta.runtime.env as Env;
    // The shard answers as a shard without the fragment does (browser-fragment-shard.ts).
    placement = {
      kind: "link",
      send: async () => new Response(`cellb: no fragment "${G}" in this shard`, { status: 503 }),
    };
    await expect(env.API.hello("x")).rejects.toMatchObject({
      name: "ServiceUnavailableError",
      message: expect.stringContaining("the link answered 503"),
    });
    placement = {
      kind: "link",
      send: () => Promise.reject(new Error("The link is closed")),
    };
    await expect(env.API.hello("x")).rejects.toMatchObject({
      name: "ServiceUnavailableError",
      message: expect.stringContaining("The link is closed"),
    });
  });
});

/** A host's `serveLink` on a real HTTP server: its base URL. */
async function serveHttp(handler: (r: Request) => Promise<Response>): Promise<string> {
  const server: Server = createServer(async (req, res) => {
    const body =
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : (Readable.toWeb(req) as ReadableStream<Uint8Array>);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const answer = await handler(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers,
        body,
        duplex: "half",
      } as RequestInit),
    );
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    if (answer.body) for await (const chunk of answer.body) res.write(chunk);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise((r) => server.close(r)));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

describe("service bindings to another host (HTTP, by the route table)", () => {
  test("fetch and JS RPC over HTTP to <url>/fragments/{id}/", async () => {
    const b = host();
    await b.add(G, GAMMA);
    const url = await serveHttp((r) => b.serveLink(r));
    const a = host({ routes: { [G]: { host: `url:${url}` } } });
    await a.add(D, DELTA);
    await contractChecks(envOf(a, D));
    // The caller's Worker code too.
    const res = await a.fetch(new Request(`http://localhost/fragments/${D}/hello`));
    expect(await res.json()).toBe('hello delta from gamma, props {"who":"delta"}');
  });

  test("across HTTPeers: /peers/{peerId}/fragments/{id}/ through the gateway", async () => {
    const b = host({ peerId: "peer-b" });
    await b.add(G, GAMMA);
    const seen: string[] = [];
    const a = host({
      routes: (id) => (id === G ? { host: "peer:peer-b" } : undefined),
      remote: {
        peers: "https://gateway.example",
        // The gateway, as HTTPeers routes it: to peer-b's link.
        fetch: (req) => {
          seen.push(new URL(req.url).pathname);
          return b.serveLink(req);
        },
      },
    });
    await a.add(D, DELTA);
    expect(await envOf(a, D).API.hello("p")).toContain("hello p from gamma");
    expect(seen).toEqual([`/peers/peer-b/fragments/${G}/`]);
  });

  test("a host that does not hold the fragment, or cannot be reached, is unavailable", async () => {
    const b = host();
    const url = await serveHttp((r) => b.serveLink(r));
    const a = host({ routes: { [G]: { host: `url:${url}` } } });
    await a.add(D, DELTA);
    const env = envOf(a, D);
    await expect(env.API.hello("x")).rejects.toMatchObject({
      name: "ServiceUnavailableError",
      message: expect.stringContaining(`no fragment "${G}" is active on this host`),
    });
    await expect(env.GAMMA.fetch("http://gamma/")).rejects.toBeInstanceOf(ServiceUnavailableError);
    const nowhere = host({ routes: { [G]: { host: "url:http://127.0.0.1:1" } } });
    await nowhere.add(D, DELTA);
    await expect(envOf(nowhere, D).API.hello("x")).rejects.toBeInstanceOf(ServiceUnavailableError);
    // A peer route without a gateway.
    const lost = host({ routes: { [G]: { host: "peer:p" } } });
    await lost.add(D, DELTA);
    await expect(envOf(lost, D).API.hello("x")).rejects.toMatchObject({
      name: "ServiceUnavailableError",
      message: expect.stringContaining("this host has no way there"),
    });
  });

  test("the public fetch runs no entrypoint calls: only serveLink does", async () => {
    const b = host();
    await b.add(G, GAMMA);
    const a = host({
      routes: { [G]: { host: "url:http://b.example" } },
      remote: { fetch: (req) => b.fetch(req) },
    });
    await a.add(D, DELTA);
    await expect(envOf(a, D).API.hello("x")).rejects.toBeInstanceOf(ServiceUnavailableError);
  });
});
