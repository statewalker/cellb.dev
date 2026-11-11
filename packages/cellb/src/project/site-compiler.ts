/**
 * `siteCompiler`: a project's sources served by an in-browser HTTP server (`createProjectSite`,
 * hosted in a ServiceWorker by webrun-site-host), for `loadProject(files, { compile })`. Modules
 * are compiled one by one as the browser imports them; nothing is bundled.
 *
 * `loadProject` runs in a Dedicated Worker, which cannot register a ServiceWorker: the site is
 * hosted by a page. `siteHostOverPort` (worker) and `hostSitesForWorker` (page) do that over a
 * MessagePort: the worker serves the site's handler, the page mounts it in its ServiceWorker.
 */

import { SwHttpAdapter } from "@statewalker/webrun-http-browser";
import type { SiteHandler } from "@statewalker/webrun-site-builder";
import { HostedSiteBuilder } from "@statewalker/webrun-site-host";
import { linkOverPort, serveHandlerOverPort } from "../transport/port.js";
import { createProjectSite } from "./site.js";
import type { ProjectCompiler } from "./source-project.js";

/**
 * A `HostedSiteBuilder` whose page side is this package's webrun-http-browser (`SwHttpAdapter`),
 * not the older one webrun-site-host depends on (^0.7). From 0.12.5 it rebuilds a request's url at
 * the page's scheme, so a site hosted on an https page answers; and its version is the one whose
 * ServiceWorker (`sw-worker.js`) hosts serve.
 */
function newHostedSiteBuilder(): HostedSiteBuilder {
  return new HostedSiteBuilder({
    adapterFactory: ({ key, serviceWorkerUrl }) => new SwHttpAdapter({ key, serviceWorkerUrl }),
  });
}

/** A site, hosted: its base URL (ending in "/") and how to take it down. */
export interface HostedProjectSite {
  baseUrl: string;
  stop(): Promise<void>;
}

/** Hosts a site handler where this realm's code can `import()` from it. */
export type SiteHost = (handler: SiteHandler) => Promise<HostedProjectSite>;

export interface SiteCompilerOptions {
  /**
   * Where the site is hosted. Default: a ServiceWorker this realm registers (`HostedSiteBuilder`),
   * which a page can do and a Dedicated Worker cannot; in a worker, pass `siteHostOverPort(port)`
   * and call `hostSitesForWorker(port)` in the page.
   */
  host?: SiteHost;
  /** The ServiceWorker script for the default host (default: `/sw-worker.js`). */
  serviceWorkerUrl?: string;
  /** `createProjectSite`'s `lowerAwait` (default: with nodejs_compat, unless AsyncContext). */
  lowerAwait?: boolean;
}

/** The default host: a ServiceWorker registered from this realm. */
function serviceWorkerHost(serviceWorkerUrl?: string): SiteHost {
  return async (handler) => {
    if (!(globalThis as { navigator?: { serviceWorker?: unknown } }).navigator?.serviceWorker)
      throw new Error(
        "siteCompiler: this realm cannot register a ServiceWorker (a Dedicated Worker cannot): " +
          "pass `host: siteHostOverPort(port)` and call `hostSitesForWorker(port)` in the page",
      );
    const builder = newHostedSiteBuilder().setHandler(handler);
    if (serviceWorkerUrl) builder.setServiceWorkerUrl(serviceWorkerUrl);
    const site = await builder.build();
    return { baseUrl: site.baseUrl, stop: () => site.stop() };
  };
}

/**
 * A compiler for `loadProject(files, { compile })` that serves the project's modules from an
 * in-browser HTTP server (`createProjectSite`): `main` and Worker Loader code are imported from
 * it, so a change can rebuild one module. The site stops when the project closes.
 */
export function siteCompiler(options: SiteCompilerOptions = {}): ProjectCompiler {
  const host = options.host ?? serviceWorkerHost(options.serviceWorkerUrl);
  return {
    kind: "site",
    async compile({ files, nodeCompat }) {
      let nodeModules: Record<string, unknown> | undefined;
      if (nodeCompat) {
        // The served `node:*` proxies take their export names from the registry entries, which
        // the browser host binds in this realm; the npm `util` polyfill reads `process` when it
        // is imported.
        (await import("../node-compat/install.js")).installNodeGlobals();
        nodeModules = (await import("../node-compat/browser-registry.js")).nodeRegistryEntries;
      }
      const handler = createProjectSite({
        projectFiles: files,
        nodeCompat,
        nodeModules,
        lowerAwait: options.lowerAwait,
      });
      const site = await host(handler);
      const baseUrl = site.baseUrl.endsWith("/") ? site.baseUrl : `${site.baseUrl}/`;
      return { code: { site: baseUrl }, close: () => site.stop() };
    },
  };
}

const HOST_SITE = "cellb:host-site";
const STOP_SITE = "cellb:stop-site";

/**
 * Where a worker and its page talk about sites: a MessagePort, the `Worker` (page side) or the
 * worker's own scope (`self`). Other messages on it are left alone.
 */
export interface SiteControl {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (e: MessageEvent) => void): void;
}

/** What a worker asks its page for, on the control port. */
interface HostSiteRequest {
  type: typeof HOST_SITE;
  /** The worker serves the site's handler on this port's other end. */
  link: MessagePort;
  /** The page answers here, and the worker asks to stop here. */
  reply: MessagePort;
}

/** The next message on `port`, or `{ error }` after `timeoutMs` (a page that never answers). */
const once = (port: MessagePort, timeoutMs: number) =>
  new Promise<{ baseUrl?: string; error?: string }>((resolve) => {
    const timer = setTimeout(
      () =>
        resolve({ error: `no answer in ${timeoutMs} ms (does the page run hostSitesForWorker?)` }),
      timeoutMs,
    );
    port.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data);
    };
  });

/**
 * Worker side: hosts each site through the page at the other end of `control`, which runs
 * `hostSitesForWorker`. The handler stays in this worker; the page's ServiceWorker forwards each
 * request to it.
 */
export function siteHostOverPort(
  control: SiteControl,
  /**
   * How long the page may take to host the site (default 30 s; a ServiceWorker's first install
   * can be slow), and to confirm it stopped one (default 2 s; the worker stops serving anyway).
   */
  {
    timeoutMs = 30_000,
    stopTimeoutMs = 2_000,
  }: { timeoutMs?: number; stopTimeoutMs?: number } = {},
): SiteHost {
  return async (handler) => {
    const link = new MessageChannel();
    const reply = new MessageChannel();
    const stopServing = await serveHandlerOverPort(link.port1, handler);
    const answered = once(reply.port1, timeoutMs);
    const request: HostSiteRequest = { type: HOST_SITE, link: link.port2, reply: reply.port2 };
    control.postMessage(request, [link.port2, reply.port2]);
    const { baseUrl, error } = await answered;
    if (!baseUrl) {
      // A page that hosts the site after all finds this stop waiting for it, and takes the site
      // down (its port stays open for that).
      reply.port1.onmessage = null;
      reply.port1.postMessage({ type: STOP_SITE });
      await stopServing();
      throw new Error(`the page did not host the site: ${error}`);
    }
    return {
      baseUrl,
      stop: async () => {
        // A page that does not answer stops nothing: the worker stops serving all the same.
        const stopped = once(reply.port1, stopTimeoutMs);
        reply.port1.postMessage({ type: STOP_SITE });
        await stopped;
        reply.port1.close();
        await stopServing();
      },
    };
  };
}

/**
 * Page side: hosts in this page's ServiceWorker the sites a worker asks for over `control`
 * (`siteHostOverPort`). Returns a function that stops listening; the sites stop when the worker
 * stops them.
 */
export function hostSitesForWorker(
  control: SiteControl,
  options: { serviceWorkerUrl?: string } = {},
): () => void {
  const listener = async (e: MessageEvent) => {
    const req = e.data as HostSiteRequest | undefined;
    if (req?.type !== HOST_SITE) return;
    try {
      // The worker may give up waiting (`timeoutMs`) and ask to stop before the site is up: the
      // stop then waits on `reply` until the handler below reads it.
      const link = await linkOverPort(req.link);
      const builder = newHostedSiteBuilder().setHandler(link.send);
      if (options.serviceWorkerUrl) builder.setServiceWorkerUrl(options.serviceWorkerUrl);
      const site = await builder.build();
      req.reply.onmessage = async (m) => {
        if ((m.data as { type?: string })?.type !== STOP_SITE) return;
        await site.stop().catch(() => {});
        await link.close().catch(() => {});
        req.reply.postMessage({ stopped: true });
        req.reply.close();
      };
      req.reply.postMessage({ baseUrl: site.baseUrl });
    } catch (err) {
      req.reply.postMessage({ error: String((err as Error)?.message ?? err) });
      req.reply.close();
    }
  };
  control.addEventListener("message", listener);
  (control as { start?: () => void }).start?.();
  return () => control.removeEventListener("message", listener);
}
