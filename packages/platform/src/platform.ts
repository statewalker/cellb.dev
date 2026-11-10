/**
 * The platform: every app of this package behind one fetch handler, with all their Durable
 * Object classes. Hosts without cross-script service bindings (celld, cellb) run it as one
 * script; the apps can also be deployed alone (src/entries/*.ts).
 */
import { BuildJob, handleBuilds } from "@statewalker/cellb-bundler/job";
import { handleCdn, ModuleHost } from "@statewalker/cellb-esm-cdn";
import { handleProjects, Project } from "@statewalker/cellb-esm-cdn/projects";
import { handleNotebooks, NotebookSite } from "@statewalker/cellb-notebooks";
import type { PlatformEnv } from "@statewalker/cellb-platform-core/env";
import { handleRegistry, PackageRegistry } from "@statewalker/cellb-platform-core/registry";
import { authorized, CORS, text, withCors } from "@statewalker/cellb-platform-core/util";

export type { PlatformEnv };
export { BuildJob, ModuleHost, NotebookSite, PackageRegistry, Project };

type Handler = (req: Request, env: PlatformEnv, ctx: ExecutionContext) => Promise<Response>;

/** The apps, each with the routes it serves. The package store (`registry`) backs all of them. */
export const APPS = {
  registry: [["/registry/", (r, e) => handleRegistry(r, e)]],
  cdn: [["/npm/", (r, e) => handleCdn(r, e)]],
  projects: [["/p/", (r, e) => handleProjects(r, e)]],
  bundler: [
    ["/builds", (r, e) => handleBuilds(r, e)],
    ["/b/", (r, e) => handleBuilds(r, e)],
  ],
  notebooks: [["/nb/", (r, e) => handleNotebooks(r, e)]],
} satisfies Record<string, [string, Handler][]>;
export type AppName = keyof typeof APPS;

const INDEX_HEAD = "webrun platform\n";
const APP_LINES: Record<AppName, string> = {
  registry: "/registry/<name>                    npm registry, cached (package store)",
  cdn: "/npm/<browser|node>/<spec>          ESM CDN (webrun-modules)",
  projects: "/p/<project>/…                      user code as ESM (webrun-modules)",
  bundler: "/builds, /b/<build>/…               bundler (webrun-bundler)",
  notebooks: "/nb/<site>/…                        Observable notebooks compiled to pages",
};

/** A fetch handler serving `apps` (default: all of them). */
export function createHandler(apps: AppName[] = Object.keys(APPS) as AppName[]) {
  const routes = apps.flatMap((a) => APPS[a] as [string, Handler][]);
  const index = `${INDEX_HEAD}\n${apps.map((a) => `  ${APP_LINES[a]}`).join("\n")}\n`;
  return async (request: Request, env: PlatformEnv, ctx: ExecutionContext): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    // A build's inputs are its sources: a read that needs the token too.
    const privateRead = /^\/builds\/[^/]+\/input\.zip$/.test(url.pathname);
    if (!authorized(request, env.PLATFORM_TOKEN, privateRead))
      return withCors(
        text("unauthorized: this platform requires Authorization: Bearer <PLATFORM_TOKEN>\n", 401),
      );
    for (const [prefix, handler] of routes) {
      if (url.pathname.startsWith(prefix) || `${url.pathname}/` === prefix) {
        try {
          return withCors(await handler(request, env, ctx));
        } catch (e) {
          // The stack goes to the log, not to the client.
          console.error(`[platform] ${request.method} ${url.pathname}:`, e);
          return withCors(text(`internal error: ${(e as Error).message ?? e}\n`, 500));
        }
      }
    }
    if (url.pathname === "/") return text(index);
    return text("not found\n", 404);
  };
}

/** The composed platform: every app. */
export const handlePlatform = createHandler();
