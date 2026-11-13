// A loaded Worker that imports its own modules from code it builds at run time, as Kitesurf's
// importModule does: `new AsyncFunction("spec", "return await import(spec)")`.
const MAIN = `
import { WorkerEntrypoint } from "cloudflare:workers";
const importModule = new (async () => {}).constructor("spec", "return await import(spec);");
const viaFunction = new Function("spec", "return import(spec);");
export default class extends WorkerEntrypoint {
  async run() {
    const byUrl = await importModule("https://example.test/app/index.js");
    const relative = await importModule("./pages/one.js");
    const plain = await viaFunction("pages/one.js");
    return { byUrl: byUrl.default, named: byUrl.answer, relative: relative.default, plain: plain.default,
             isFunction: viaFunction instanceof Function };
  }
}`;
export default {
  async fetch(request, env) {
    const child = env.LOADER.get("function-import", () => ({
      compatibilityDate: "2026-01-01",
      mainModule: "main.js",
      modules: {
        "main.js": MAIN,
        "pages/one.js": "export default 'one';",
        "https://example.test/app/index.js":
          "import dep from './dep.js'; export const answer = 42; export default 'index+' + dep;",
        "https://example.test/app/dep.js": "export default 'dep';",
      },
    })).getEntrypoint();
    return Response.json(await child.run());
  },
};
