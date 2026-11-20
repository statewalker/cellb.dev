// A Lifo container whose sockets out of the box go to a WebSocket handler of the host's choosing
// (here an echo handler in this worker), through a WHATWG WebSocket class from
// @statewalker/webrun-http-browser installed as the box's WebSocket.
import { parentPort } from "node:worker_threads";
import * as lifo from "@lifo-sh/core";
import {
  createWebSocketClass,
  isWebSocketUpgrade,
  serveWebSocketUpgrade,
  upgradeWebSocket,
} from "@statewalker/webrun-http-browser";
import { lifoContainerEngine } from "../../src/lifo-engine.ts";
import { serveContainerWorker } from "../../src/worker.ts";

const echo = (request: Request) => {
  if (!isWebSocketUpgrade(request)) return new Response("not a socket", { status: 426 });
  const { socket, response } = upgradeWebSocket(request);
  socket.accept();
  const path = new URL(request.url).pathname;
  socket.addEventListener("message", (e) =>
    socket.send(`host ${path} ${(e as MessageEvent).data}`),
  );
  return response;
};
const HostWebSocket = createWebSocketClass(async (url, protocols) => {
  const r = await serveWebSocketUpgrade(echo, { url, protocols });
  if (!r.ok) throw new Error(r.message);
  return { port: r.port, protocol: r.protocol };
});

serveContainerWorker(parentPort as never, ({ files }) =>
  lifoContainerEngine(lifo as never, { files, webSocket: HostWebSocket }),
);
