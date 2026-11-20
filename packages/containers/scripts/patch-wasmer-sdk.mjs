// Adds `sandbox.ports.fetch(port, request)` and `sandbox.ports.connect(port)` to @wasmer/sdk.
// Both wrap methods the SDK's wasm core already has (`handleHttpRequest`, `connectTcp`) but the
// public `Ports` class keeps private behind `#core`. This is the change to ask upstream for.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const file = join(process.argv[2], "dist/index.js");
const MARK = "/* cellb: ports.fetch/connect, mounts */";
let src = readFileSync(file, "utf8");
if (src.includes(MARK)) {
  console.log("@wasmer/sdk already patched");
  process.exit(0);
}
const anchor = "    constructor(core) {\n        this.#core = core;\n    }\n    /**\n     * Wait until a guest TCP listener";
if (!src.includes(anchor)) throw new Error("patch anchor not found: @wasmer/sdk changed");
const methods = `    constructor(core) {
        this.#core = core;
    }
    ${MARK}
    /** Send one HTTP request to a guest TCP listener, with no ServiceWorker and no host port. */
    async fetch(port, request) {
        const validPort = validateInteger("port", port, 1, 65_535);
        const req = request instanceof Request ? request : new Request(request);
        const url = new URL(req.url);
        const body = new Uint8Array(await req.arrayBuffer());
        const headers = [...req.headers.entries()];
        const res = await rethrow(this.#core.handleHttpRequest(validPort, req.method, url.pathname + url.search, headers, body));
        const status = res.status;
        const noBody = req.method === "HEAD" || status === 204 || status === 304 || (status >= 100 && status < 200);
        return new Response(noBody ? null : Uint8Array.from(res.body), { status, statusText: res.statusText, headers: res.headers });
    }
    /** Open a raw TCP connection to a guest listener: { readable, writable, close() }. */
    connect(port) {
        const validPort = validateInteger("port", port, 1, 65_535);
        const conn = this.#core.connectTcp(validPort);
        let closed = false;
        const close = () => { if (!closed) { closed = true; try { conn.close(); } catch {} } };
        const readable = new ReadableStream({
            async pull(controller) {
                const chunk = await rethrow(conn.read());
                if (!chunk || chunk.length === 0) controller.close();
                else controller.enqueue(Uint8Array.from(chunk));
            },
            cancel: close,
        }, { highWaterMark: 0 });
        const writable = new WritableStream({
            async write(chunk) {
                for (let i = 0; i < chunk.length; i += 65_536) await rethrow(conn.write(chunk.subarray(i, i + 65_536)));
            },
            close() { conn.shutdownWrite(); },
            abort: close,
        });
        return { readable, writable, close };
    }
    /**
     * Wait until a guest TCP listener`;
src = src.replace(anchor, methods);
// Host filesystem mounts: `sandboxes.create({ mounts: [{ path, id, readOnly }], storage: id })`.
// The core already has SandboxBuilderCore.mountHost / storageHost; the public API does not pass them.
const envLoop = `        for (const [key, value] of Object.entries(options.env ?? {})) {
            builder.env(key, value);
        }
`;
if (!src.includes(envLoop)) throw new Error("patch anchor (env loop) not found");
src = src.replace(envLoop, `${envLoop}        for (const m of options.mounts ?? []) {
            builder.mountHost(m.path, m.id, !!m.readOnly);
        }
        if (options.storage !== undefined)
            builder.storageHost(options.storage);
`);
writeFileSync(file, src);
console.log("patched", file);
// Node pool workers: install the synchronous host-filesystem bridge, as browser workers do.
const nodeWorker = join(dirname(file), "node-worker.js");
let nw = readFileSync(nodeWorker, "utf8");
const nwAnchor = `installCapiObjectBridge((message, transfer = []) => port.postMessage(message, transfer));`;
if (!nw.includes(nwAnchor)) throw new Error("patch anchor (node-worker) not found");
nw = `import { installHostFileSystemWorkerBridge as __cellbFsBridge } from "./host-filesystem.js";\n` + nw.replace(nwAnchor, `${nwAnchor}\n${MARK}`);
// after globalThis.postMessage is defined:
nw = nw.replace(/(Object\.defineProperty\(globalThis, "postMessage", \{[\s\S]*?\}\);)/, "$1\n__cellbFsBridge();");
writeFileSync(nodeWorker, nw);
console.log("patched", nodeWorker);
