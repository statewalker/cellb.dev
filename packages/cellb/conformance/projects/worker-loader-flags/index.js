// WorkerCode.compatibilityFlags: what a loaded Worker sees with and without the flags cellb
// knows, and what an unknown flag does.
const tryIt = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    return `${e.name}: ${String(e.message).split("\n")[0].slice(0, 150)}`;
  }
};

const MAIN = `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  process() {
    return typeof process;
  }
  binaryType() {
    return new WebSocketPair()[0].binaryType;
  }
}
`;
const NODE_IMPORT = `
import { Buffer } from "node:buffer";
export default { fetch() { return new Response(Buffer.from("hi").toString("base64")); } };
`;

export default {
  async fetch(request, env) {
    const load = (id, flags, main = MAIN) =>
      env.LOADER.get(id, () => ({
        compatibilityDate: "2026-01-01",
        compatibilityFlags: flags,
        mainModule: "main.js",
        modules: { "main.js": main },
      }));
    const probe = (id, flags, what) => tryIt(() => load(id, flags).getEntrypoint()[what]());
    const fetchText = (id, flags, main) =>
      tryIt(async () => (await load(id, flags, main).getEntrypoint().fetch("http://w/")).text());
    const { pathname } = new URL(request.url);
    if (pathname === "/unknown")
      return Response.json({ unknown: await probe("unknown", ["no_such_flag"], "process") });
    if (pathname === "/binary-type")
      return Response.json({
        none: await probe("none", [], "binaryType"),
        standard: await probe("ws", ["websocket_standard_binary_type"], "binaryType"),
      });
    if (pathname === "/node-compat")
      return Response.json({
        none: await probe("none", [], "process"),
        nodeCompat: await probe("node", ["nodejs_compat"], "process"),
        nodeImport: await fetchText("ni", [], NODE_IMPORT),
        nodeImportCompat: await fetchText("nic", ["nodejs_compat"], NODE_IMPORT),
      });
    return new Response("not found", { status: 404 });
  },
};
