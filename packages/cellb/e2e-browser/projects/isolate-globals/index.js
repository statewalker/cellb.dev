// A loaded Worker that replaces globals a browser page emulation replaces (Kitesurf's window):
// `postMessage` and `location`. Its isolate (a Dedicated Worker) must keep talking to the host.
const CHILD = `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  takeOver() {
    globalThis.postMessage = () => { throw new Error("the page's own postMessage"); };
    globalThis.location = { href: "https://example.test/" };
    return "taken";
  }
  ping(n) { return { n, href: globalThis.location.href }; }
}`;
export default {
  async fetch(request, env) {
    const child = env.LOADER.get("globals", () => ({
      compatibilityDate: "2026-01-01",
      mainModule: "child.js",
      modules: { "child.js": CHILD },
    })).getEntrypoint();
    const taken = await child.takeOver();
    const pings = [await child.ping(1), await child.ping(2)];
    return Response.json({ taken, pings });
  },
};
