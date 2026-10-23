/**
 * WebSocket conformance cases — one list, run against several implementations:
 *   - native WebSocket (browser / Node) ⇄ reference `ws` server,
 *   - webrun-cells sockets ⇄ Room Durable Object (in-process, worker-thread shards,
 *     browser ServiceWorker + shard workers, local and cross-shard).
 * The cases encode the WHATWG WebSocket behaviour; a difference between the native
 * run and a cells run is a bug in webrun-cells (or a documented platform difference).
 * No Node or DOM-only imports: this module is loaded by vitest AND by the browser page.
 */

// biome-ignore lint/suspicious/noExplicitAny: WebSocket-compatible constructors differ per runtime
export type WSClass = any;

export interface WsEnv {
  /** Implementation under test (native or webrun-cells class). */
  WS: WSClass;
  /** URL of a room (fresh name per call is the caller's job). */
  room(name: string): string;
  /** URL that refuses the upgrade (404 / not a WebSocket endpoint). */
  refused: string;
  /** Label for messages. */
  label: string;
}

export class CaseFailure extends Error {}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new CaseFailure(msg);
}
function same(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new CaseFailure(`${msg}: expected ${e}, got ${a}`);
}

const uniq = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function events(ws: WSClass) {
  const log: string[] = [];
  const queue: MessageEvent[] = [];
  const waiters: ((e: MessageEvent) => void)[] = [];
  ws.addEventListener("open", () => log.push("open"));
  ws.addEventListener("error", () => log.push("error"));
  ws.addEventListener("close", (e: CloseEvent) => log.push(`close:${e.code}`));
  ws.addEventListener("message", (e: MessageEvent) => {
    const w = waiters.shift();
    w ? w(e) : queue.push(e);
  });
  return {
    log,
    message: (timeoutMs = 5_000) =>
      new Promise<MessageEvent>((resolve, reject) => {
        const q = queue.shift();
        if (q) return resolve(q);
        const t = setTimeout(() => reject(new CaseFailure("no message within timeout")), timeoutMs);
        waiters.push((e) => (clearTimeout(t), resolve(e)));
      }),
  };
}

const once = <T = Event>(ws: WSClass, type: string, timeoutMs = 5_000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new CaseFailure(`no "${type}" event within ${timeoutMs} ms`)),
      timeoutMs,
    );
    ws.addEventListener(type, (e: T) => (clearTimeout(t), resolve(e)), { once: true });
  });

async function opened(env: WsEnv, protocols?: string | string[]) {
  const ws =
    protocols === undefined
      ? new env.WS(env.room(uniq()))
      : new env.WS(env.room(uniq()), protocols);
  const ev = events(ws);
  await once(ws, "open");
  return { ws, ev };
}

async function bytesOf(data: unknown): Promise<number[]> {
  if (data instanceof ArrayBuffer) return [...new Uint8Array(data)];
  if (typeof Blob !== "undefined" && data instanceof Blob)
    return [...new Uint8Array(await data.arrayBuffer())];
  throw new CaseFailure(
    `binary payload of unexpected type ${Object.prototype.toString.call(data)}`,
  );
}

export const cases: Record<string, (env: WsEnv) => Promise<void>> = {
  async "open: readyState, url, extensions, bufferedAmount"(env) {
    const url = env.room(uniq());
    const ws = new env.WS(url);
    same(ws.readyState, 0, "readyState while connecting");
    same(ws.url, new URL(url).href, "url");
    same(ws.binaryType, "blob", "default binaryType");
    await once(ws, "open");
    same([ws.readyState, ws.extensions, ws.bufferedAmount], [1, "", 0], "state after open");
    ws.close();
  },

  async "constants on the class and on instances"(env) {
    same(
      [env.WS.CONNECTING, env.WS.OPEN, env.WS.CLOSING, env.WS.CLOSED],
      [0, 1, 2, 3],
      "static constants",
    );
    const { ws } = await opened(env);
    same([ws.CONNECTING, ws.OPEN, ws.CLOSING, ws.CLOSED], [0, 1, 2, 3], "instance constants");
    ws.close();
  },

  async "subprotocol: server selects the first offered; none offered → empty"(env) {
    const a = await opened(env, ["chat.v2", "chat.v1"]);
    same(a.ws.protocol, "chat.v2", "negotiated protocol");
    a.ws.close();
    const b = await opened(env, "solo");
    same(b.ws.protocol, "solo", "single string protocol");
    b.ws.close();
    const c = await opened(env);
    same(c.ws.protocol, "", "no protocol");
    c.ws.close();
  },

  async "subprotocol: duplicates or invalid tokens → SyntaxError"(env) {
    for (const bad of [["a", "a"], ["has space"], [""]]) {
      let name = "";
      try {
        new env.WS(env.room(uniq()), bad).close();
      } catch (e) {
        name = (e as DOMException).name;
      }
      same(name, "SyntaxError", `protocols ${JSON.stringify(bad)}`);
    }
  },

  async "url: http(s) becomes ws(s); other schemes and fragments → SyntaxError"(env) {
    const http = env.room(uniq()).replace(/^ws/, "http");
    const ws = new env.WS(http);
    check(ws.url.startsWith("ws"), `http URL normalised to ws (got ${ws.url})`);
    await once(ws, "open");
    ws.close();
    for (const bad of ["ftp://example.com/x", `${env.room(uniq())}#frag`]) {
      let name = "";
      try {
        new env.WS(bad).close();
      } catch (e) {
        name = (e as DOMException).name;
      }
      same(name, "SyntaxError", `URL ${bad}`);
    }
  },

  async "text: unicode round trip and order of 50 messages"(env) {
    const { ws, ev } = await opened(env);
    const texts = Array.from({ length: 50 }, (_, i) => `msg ${i} — ünïcødé ✓ 🚀`);
    for (const t of texts) ws.send(t);
    const got: string[] = [];
    for (let i = 0; i < texts.length; i++) got.push((await ev.message()).data);
    same(got, texts, "messages in order");
    ws.close();
  },

  async "binary: ArrayBuffer, Uint8Array, DataView, Blob; binaryType arraybuffer"(env) {
    const { ws, ev } = await opened(env);
    ws.binaryType = "arraybuffer";
    ws.send(new Uint8Array([1, 2, 3]).buffer);
    same(await bytesOf((await ev.message()).data), [3, 2, 1], "ArrayBuffer");
    ws.send(new Uint8Array([9, 8, 7, 6]).subarray(1, 3)); // view on a larger buffer
    same(await bytesOf((await ev.message()).data), [7, 8], "Uint8Array view");
    ws.send(new DataView(new Uint8Array([5, 4]).buffer));
    same(await bytesOf((await ev.message()).data), [4, 5], "DataView");
    if (typeof Blob !== "undefined") {
      ws.send(new Blob([new Uint8Array([10, 20])]));
      const m = await ev.message();
      check(m.data instanceof ArrayBuffer, "arraybuffer binaryType yields ArrayBuffer");
      same(await bytesOf(m.data), [20, 10], "Blob");
    }
    ws.close();
  },

  async "binary: default binaryType delivers a Blob"(env) {
    if (typeof Blob === "undefined") return;
    const { ws, ev } = await opened(env);
    ws.send(new Uint8Array([1, 2]));
    const m = await ev.message();
    check(
      m.data instanceof Blob,
      `default binaryType blob (got ${Object.prototype.toString.call(m.data)})`,
    );
    same(await bytesOf(m.data), [2, 1], "Blob payload");
    ws.close();
  },

  async "large: 1 MiB text from the server, 1 MiB binary round trip"(env) {
    const { ws, ev } = await opened(env);
    ws.binaryType = "arraybuffer";
    ws.send(`big:${1 << 20}`);
    const big = (await ev.message(15_000)).data as string;
    same(big.length, 1 << 20, "text length");
    const bin = new Uint8Array(1 << 20).map((_, i) => i % 251);
    ws.send(bin);
    const back = new Uint8Array((await ev.message(15_000)).data);
    same(
      [back.length, back[0], back[back.length - 1]],
      [1 << 20, bin[bin.length - 1], bin[0]],
      "binary reversed",
    );
    ws.close();
  },

  async "broadcast: every socket of the room receives"(env) {
    const room = env.room(uniq());
    const a = new env.WS(room);
    const b = new env.WS(room);
    const [ea, eb] = [events(a), events(b)];
    await Promise.all([once(a, "open"), once(b, "open")]);
    b.send("hello all");
    same(
      [(await ea.message()).data, (await eb.message()).data],
      ["hello all", "hello all"],
      "broadcast",
    );
    a.close();
    b.close();
  },

  async "client close with code and reason: CLOSING → CLOSED, clean, later send ignored"(env) {
    const { ws } = await opened(env);
    const closed = once<CloseEvent>(ws, "close");
    ws.close(4100, "client done");
    same(ws.readyState, 2, "readyState after close()");
    const e = await closed;
    same(
      [e.code, e.reason, e.wasClean, ws.readyState],
      [4100, "client done", true, 3],
      "close event",
    );
    ws.send("ignored"); // must not throw
    ws.close(); // idempotent
  },

  async "client close without code → 1005"(env) {
    const { ws } = await opened(env);
    const closed = once<CloseEvent>(ws, "close");
    ws.close();
    const e = await closed;
    same([e.code, e.wasClean], [1005, true], "close without code");
  },

  async "server close: code and reason reach the client"(env) {
    const { ws } = await opened(env);
    const closed = once<CloseEvent>(ws, "close");
    ws.send("bye");
    const e = await closed;
    same([e.code, e.reason, e.wasClean], [4000, "bye bye", true], "server close");
  },

  async "close() while CONNECTING: no open, close event, socket CLOSED"(env) {
    const ws = new env.WS(env.room(uniq()));
    const ev = events(ws);
    ws.close();
    same(ws.readyState, 2, "readyState right after close()");
    await once(ws, "close");
    await sleep(50);
    check(!ev.log.includes("open"), `no open event (log ${ev.log.join(",")})`);
    same(ws.readyState, 3, "readyState after close event");
  },

  async "send() while CONNECTING throws InvalidStateError"(env) {
    const ws = new env.WS(env.room(uniq()));
    let name = "";
    try {
      ws.send("too early");
    } catch (e) {
      name = (e as DOMException).name;
    }
    same(name, "InvalidStateError", "send while connecting");
    ws.close();
  },

  async "close() argument validation"(env) {
    const { ws } = await opened(env);
    const errs: string[] = [];
    for (const [code, reason] of [
      [1001, undefined],
      [2999, undefined],
      [5000, undefined],
      [4000, "x".repeat(124)],
    ] as const) {
      try {
        ws.close(code, reason);
        errs.push("none");
      } catch (e) {
        errs.push((e as DOMException).name);
      }
    }
    same(
      errs,
      ["InvalidAccessError", "InvalidAccessError", "InvalidAccessError", "SyntaxError"],
      "validation",
    );
    same(ws.readyState, 1, "still open after rejected close() calls");
    ws.close(1000);
  },

  async "refused upgrade: error then close 1006, never open"(env) {
    const ws = new env.WS(env.refused);
    const ev = events(ws);
    const e = await once<CloseEvent>(ws, "close", 8_000);
    same([e.code, e.wasClean], [1006, false], "close event");
    same(ev.log, ["error", "close:1006"], "event order");
    same(ws.readyState, 3, "readyState");
  },

  async "handlers: on* and addEventListener both fire; open before messages"(env) {
    const ws = new env.WS(env.room(uniq()));
    const seen: string[] = [];
    ws.onopen = () => {
      seen.push("onopen");
      ws.send("ping-text");
    };
    ws.addEventListener("open", () => seen.push("listener:open"));
    const msg = new Promise<void>((r) => {
      ws.onmessage = (e: MessageEvent) => {
        seen.push(`onmessage:${e.data}`);
        r();
      };
    });
    await msg;
    const closed = new Promise<void>((r) => {
      ws.onclose = () => (seen.push("onclose"), r());
    });
    ws.close();
    await closed;
    same(seen, ["onopen", "listener:open", "onmessage:ping-text", "onclose"], "handler order");
  },

  async "server sees clients leave: room count drops after a client closes"(env) {
    const room = env.room(uniq());
    const a = new env.WS(room);
    const b = new env.WS(room);
    const ea = events(a);
    await Promise.all([once(a, "open"), once(b, "open")]);
    a.send("count?");
    same((await ea.message()).data, "count:2", "two sockets");
    const closed = once(b, "close");
    b.close();
    await closed;
    await sleep(100);
    a.send("count?");
    same((await ea.message()).data, "count:1", "one socket left");
    a.close();
  },
};
