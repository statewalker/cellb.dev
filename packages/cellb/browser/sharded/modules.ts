// webrun-modules inside the ServiceWorker: transforms the user sources on request and
// serves them under {scope}modules/. Free globals WebSocket / WebSocketPair / Response
// and the bare specifier "cloudflare:workers" become ~deps proxies that read
// globalThis.__webrunHostRegistry of the realm that imports them (page or shard worker).

import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newModuleServer } from "@statewalker/webrun-modules";
import chatClient from "./user/chat-client.ts?raw";
import lobbyWorker from "./user/lobby-worker.ts?raw";

const fromRegistry = (name: string) =>
  `globalThis.__webrunHostRegistry.get(${JSON.stringify(name)})`;

export async function createModules(basePath: string) {
  const project = new MemFilesApi();
  await writeText(project, "/lobby-worker.ts", lobbyWorker);
  await writeText(project, "/chat-client.ts", chatClient);
  return newModuleServer({
    cache: new MemFilesApi(),
    project,
    basePath,
    target: "browser",
    // Only the NAMES matter here; each importing realm registers its own values.
    provided: { "cloudflare:workers": {} },
    globals: {
      WebSocket: fromRegistry("WebSocket"),
      WebSocketPair: fromRegistry("WebSocketPair"),
      Response: fromRegistry("Response"),
    },
  });
}
