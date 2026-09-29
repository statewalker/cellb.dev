import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newModuleServer } from "@statewalker/webrun-modules";

const project = new MemFilesApi();
await writeText(
  project,
  "/worker.ts",
  `
export function open(url: string) { return new WebSocket(url); }
export function pair() { const p = new WebSocketPair(); return Object.values(p).length; }
export const hasNative = typeof WebSocket;
`,
);
for (const variant of ["provided-only", "globals"]) {
  const opts = {
    cache: new MemFilesApi(),
    project,
    target: "browser",
    provided: {
      WebSocket: class FakeWS {
        constructor(u) {
          this.url = u;
        }
      },
      WebSocketPair: class {
        constructor() {
          this[0] = 1;
          this[1] = 2;
        }
      },
    },
  };
  if (variant === "globals")
    opts.globals = {
      WebSocket: `globalThis.__webrunHostRegistry.get("WebSocket")`,
      WebSocketPair: `globalThis.__webrunHostRegistry.get("WebSocketPair")`,
    };
  const server = newModuleServer(opts);
  const urls = await server.listResources({ url: "/worker.ts" }).catch((e) => ["ERR " + e.message]);
  console.log("==", variant, urls);
  for (const u of urls)
    if (!u.startsWith("ERR")) {
      const r = await server.fetch(new Request("http://x" + u));
      console.log("--", u, "\n" + (await r.text()).slice(0, 500));
    }
}
