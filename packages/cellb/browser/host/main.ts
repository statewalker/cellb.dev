// The browser host app: load a Workers project (a folder with wrangler.json[c] and its code),
// run it in a worker — on a celld fleet bucket in this origin's OPFS, or on an S3 bucket shared
// with celld nodes — and serve it to the page through the ServiceWorker at its own base URL.
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { HostedSiteBuilder } from "@statewalker/webrun-site-host";
import { createProjectSite } from "../../src/project/site.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const jsonc = (text: string) =>
  JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, "$1"));

let worker: Worker | undefined;
let stopSites: (() => Promise<void>) | undefined;
const call = <T>(msg: unknown, transfer: Transferable[] = []) =>
  new Promise<T>((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (e) => resolve(e.data as T);
    worker!.postMessage(msg, [port2, ...transfer]);
  });

export interface HostOptions {
  /** project files: relative path → bytes (must contain wrangler.json or wrangler.jsonc) */
  files: Map<string, Uint8Array>;
  bucket?: { opfs: string; node: string } | { s3: Record<string, string>; node: string };
  pool?: string;
}

/** Starts the project; returns the URL its app is served at. */
export async function startHost(
  o: HostOptions,
): Promise<{ appUrl: string; unsupported: string[] }> {
  await stopHost();
  const configText = new TextDecoder().decode(
    o.files.get("wrangler.jsonc") ?? o.files.get("wrangler.json") ?? new Uint8Array(),
  );
  if (!configText) throw new Error("the project has no wrangler.json(c)");
  const config = jsonc(configText);
  const projectFiles = new MemFilesApi();
  for (const [p, bytes] of o.files) await projectFiles.write(`/${p}`, [bytes]);
  const assetsDir = (config.assets?.directory ?? "").replace(/^\.\//, "").replace(/\/$/, "");
  const assets: [string, string][] = assetsDir
    ? [...o.files]
        .filter(([p]) => p.startsWith(`${assetsDir}/`))
        .map(([p, b]) => [p.slice(assetsDir.length), b64(b)])
    : [];
  const nodeCompat = (config.compatibility_flags ?? []).some((f: string) =>
    f.startsWith("nodejs_compat"),
  );
  const modules = await new HostedSiteBuilder()
    .setSiteKey(`host-modules-${Math.random().toString(36).slice(2, 8)}`)
    .setHandler(
      createProjectSite({
        projectFiles,
        nodeCompat,
        nodeModules: nodeCompat
          ? (await import("../../src/node-compat/browser-registry.js")).nodeRegistryEntries
          : undefined,
      }),
    )
    .build();
  worker = new Worker(new URL("./host-worker.ts", import.meta.url), { type: "module" });
  const started = await call<{ ok: boolean; error?: string; unsupported: string[] }>({
    type: "start",
    name: config.name ?? "app",
    baseUrl: modules.baseUrl,
    config,
    assets,
    bucket: o.bucket,
    pool: o.pool ?? `host-${config.name ?? "app"}`,
  });
  if (!started.ok) throw new Error(started.error);
  // The app's own origin-relative site: every request goes to the worker's runtime.
  const app = await new HostedSiteBuilder()
    .setSiteKey(`host-app-${Math.random().toString(36).slice(2, 8)}`)
    .setHandler(async (req: Request) => {
      const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
      const r = await call<{
        status: number;
        statusText?: string;
        headers: [string, string][];
        body: ArrayBuffer;
      }>(
        { type: "fetch", url: req.url, method: req.method, headers: [...req.headers], body },
        body ? [body] : [],
      );
      return new Response(r.status === 204 || r.status === 304 ? null : r.body, {
        status: r.status,
        statusText: r.statusText,
        headers: r.headers,
      });
    })
    .build();
  stopSites = async () => {
    await app.stop();
    await modules.stop();
  };
  return { appUrl: app.baseUrl, unsupported: started.unsupported };
}

export async function stopHost(): Promise<void> {
  if (worker) {
    await call({ type: "stop" });
    worker.terminate();
    worker = undefined;
  }
  await stopSites?.();
  stopSites = undefined;
}

/** Cells this node owns in the fleet bucket. */
export const ownedCells = async () =>
  worker ? (await call<{ owned: string[] }>({ type: "owned" })).owned : [];

// ---- the page ----
(window as any).__host = { startHost, stopHost, ownedCells };
const form = document.getElementById("host-form") as HTMLFormElement | null;
if (form) {
  const kind = $<HTMLSelectElement>("bucket-kind");
  const s3 = $<HTMLFieldSetElement>("s3-fields");
  kind.onchange = () => (s3.hidden = kind.value !== "s3");
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const status = $<HTMLElement>("status");
    try {
      const input = $<HTMLInputElement>("project");
      const files = new Map<string, Uint8Array>();
      for (const f of Array.from(input.files ?? [])) {
        const rel =
          (f as File & { webkitRelativePath: string }).webkitRelativePath
            .split("/")
            .slice(1)
            .join("/") || f.name;
        files.set(rel, new Uint8Array(await f.arrayBuffer()));
      }
      const node =
        $<HTMLInputElement>("node").value || `browser-${Math.random().toString(36).slice(2, 8)}`;
      const bucket =
        kind.value === "none"
          ? undefined
          : kind.value === "opfs"
            ? { opfs: $<HTMLInputElement>("opfs").value || "fleet", node }
            : {
                s3: {
                  endpoint: $<HTMLInputElement>("s3-endpoint").value,
                  signAs:
                    $<HTMLInputElement>("s3-sign-as").value ||
                    $<HTMLInputElement>("s3-endpoint").value,
                  bucket: $<HTMLInputElement>("s3-bucket").value,
                  prefix: $<HTMLInputElement>("s3-prefix").value,
                  accessKeyId: $<HTMLInputElement>("s3-key").value,
                  secretAccessKey: $<HTMLInputElement>("s3-secret").value,
                },
                node,
              };
      status.textContent = "starting…";
      const { appUrl, unsupported } = await startHost({ files, bucket });
      $<HTMLIFrameElement>("app").src = appUrl;
      $<HTMLAnchorElement>("app-link").href = appUrl;
      $<HTMLAnchorElement>("app-link").textContent = appUrl;
      status.textContent = unsupported.length
        ? `running (unsupported: ${unsupported.join(", ")})`
        : "running";
    } catch (e) {
      status.textContent = String((e as Error)?.message ?? e);
    }
  };
  $<HTMLButtonElement>("refresh-owned").onclick = async () => {
    $<HTMLElement>("owned").textContent = (await ownedCells()).join("\n") || "(none)";
  };
  $<HTMLButtonElement>("stop").onclick = async () => {
    await stopHost();
    $<HTMLElement>("status").textContent = "stopped";
  };
}
document.body.dataset.ready = "true";
