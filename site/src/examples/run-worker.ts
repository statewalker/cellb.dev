/// <reference lib="webworker" />
// The example pages' worker. The reference server replaces `fetch` and `WebSocket` for its host,
// and cellb keeps the realm's WebSocket class when it loads: so the server is installed here,
// before the runner (and cellb with it) is imported. Messages that arrive meanwhile wait.
import "./reference-server";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const early: MessageEvent[] = [];
scope.onmessage = (e) => early.push(e);
const { handle } = await import("./runner");
scope.onmessage = handle;
for (const e of early) void handle(e);
