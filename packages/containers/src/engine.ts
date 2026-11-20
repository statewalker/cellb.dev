import { forwardHostFiles, installHostFiles } from "./files/bridge.ts";
import type { PortLike } from "./rpc.ts";
// The ContainerEngine port and its Wasmer implementation.

// The engine port and its types are cellb's (@statewalker/cellb/container): one definition of
// the API that ctx.container, the pools and every engine share.
import type {
  ContainerEngine,
  ContainerHandle,
  ContainerSpec,
  SpawnedProcess,
  TcpSocket,
} from "@statewalker/cellb/container";

export type {
  ContainerEngine,
  ContainerHandle,
  ContainerSpec,
  ExecOptions,
  ExecResult,
  SpawnedProcess,
  TcpSocket,
} from "@statewalker/cellb/container";

export interface WasmerEngineOptions {
  /**
   * Lets containers ask for `enableInternet: true`. "host" (Node only) gives them the host's
   * network with NO fence (the node, private ranges, the Internet): for trusted build steps such
   * as installing dependencies, never for code you did not write. Default: no egress.
   */
  egress?: "host";
  log?: (event: string, data?: Record<string, unknown>) => void;
}

// The subset of @wasmer/sdk this engine uses (the Node and browser clients share it). The SDK is
// patched (patches/@wasmer__sdk@0.19.1.patch): ports.fetch/connect and `mounts`.
interface WasmerProcess {
  stdin: { toWritableStream(): WritableStream<Uint8Array> } | null;
  stdout: { toReadableStream(): ReadableStream<Uint8Array>; lines(): AsyncIterable<string> } | null;
  stderr: { toReadableStream(): ReadableStream<Uint8Array>; lines(): AsyncIterable<string> } | null;
  wait(o?: { check?: boolean }): Promise<{ exitCode: number; reason: string }>;
  terminate(o?: { gracePeriodMs?: number }): Promise<void>;
  kill(): Promise<void>;
}
interface WasmerSandbox {
  command(
    cmd: string,
    args?: readonly string[],
    options?: { env?: Record<string, string>; cwd?: string },
  ): {
    run(o?: {
      check?: boolean;
    }): Promise<{ exitCode: number; stdout: { text(): string }; stderr: { text(): string } }>;
    spawn(o?: Record<string, unknown>): Promise<WasmerProcess>;
  };
  ports: {
    wait(port: number, o?: { timeoutMs?: number }): Promise<void>;
    fetch(port: number, request: Request): Promise<Response>;
    connect(port: number): TcpSocket;
  };
  close(): Promise<void>;
}
export interface WasmerLike {
  packages: { load(source: string | Uint8Array): Promise<unknown> };
  sandboxes: { create(options: Record<string, unknown>): Promise<unknown> };
}

/** A ContainerEngine on a `Wasmer` client from @wasmer/sdk/node or @wasmer/sdk/browser. */
export function wasmerContainerEngine(
  wasmer: WasmerLike,
  opts: WasmerEngineOptions = {},
): ContainerEngine {
  const log = opts.log ?? (() => {});
  // Package source -> Promise<Package>: cells share one download and compile.
  const packages = new Map<string | Uint8Array, Promise<unknown>>();
  const load = (source: string | Uint8Array) => {
    let p = packages.get(source);
    if (!p) {
      p = wasmer.packages.load(source);
      packages.set(source, p);
      p.catch(() => packages.delete(source));
    }
    return p;
  };
  const handles = new Set<ContainerHandle>();
  let live = 0;

  const spawnOf =
    (sandbox: WasmerSandbox) =>
    async (argv: string[]): Promise<SpawnedProcess> => {
      const [cmd, ...args] = argv;
      const p = await sandbox
        .command(cmd, args)
        .spawn({ stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      return {
        stdin: p.stdin!.toWritableStream(),
        stdout: p.stdout!.toReadableStream(),
        stderr: p.stderr!.toReadableStream(),
        wait: () =>
          p.wait({ check: false }).then((o) => ({ exitCode: o.exitCode, reason: o.reason })),
        kill: () => p.kill(),
      };
    };

  return {
    get running() {
      return live;
    },
    async close() {
      await Promise.all([...handles].map((h) => h.destroy().catch(() => {})));
    },
    async start(spec) {
      if (spec.enableInternet)
        throw new Error(
          "enableInternet: true needs an egress policy, which this engine does not have yet",
        );
      const t0 = performance.now();
      const pkgs = await Promise.all(spec.packages.map(load));
      const sandbox = (await wasmer.sandboxes.create({
        packages: pkgs,
        files: spec.files,
        env: spec.env,
        mounts: spec.mounts,
        // No egress, and a virtual localhost of its own: two containers cannot reach each other.
        network: { mode: "http", peers: [] },
      })) as WasmerSandbox;
      live++;
      let running = true;
      let main: WasmerProcess | undefined;
      let stopIdle: (() => void) | undefined;
      let exited: Promise<{ exitCode: number; reason: string }>;
      const output = { stdout: "", stderr: "" };
      if (spec.entrypoint?.length) {
        const [cmd, ...args] = spec.entrypoint;
        main = await sandbox.command(cmd, args).spawn({ stdout: "pipe", stderr: "pipe" });
        for (const key of ["stdout", "stderr"] as const) {
          void (async () => {
            try {
              for await (const line of main![key]!.lines())
                output[key] = `${output[key]}${line}\n`.slice(-8192);
            } catch {}
          })();
        }
        exited = main
          .wait({ check: false })
          .then((o) => ({ exitCode: o.exitCode, reason: o.reason }));
      } else {
        // An exec-only container (a sandbox) runs until destroyed.
        exited = new Promise((resolve) => {
          stopIdle = () => resolve({ exitCode: 137, reason: "terminated" });
        });
      }
      const done = exited.then((r) => {
        running = false;
        live--;
        handles.delete(handle);
        void sandbox.close().catch(() => {});
        return r;
      });
      log("container_started", { label: spec.label, startMs: Math.round(performance.now() - t0) });
      const handle: ContainerHandle & { output: typeof output } = {
        get running() {
          return running;
        },
        output,
        monitor: () => done,
        waitForPort: (port, timeoutMs = 30_000) => sandbox.ports.wait(port, { timeoutMs }),
        fetch: (port, request) => sandbox.ports.fetch(port, request),
        connect: (port) => sandbox.ports.connect(port),
        async exec(argv, options = {}) {
          const [cmd, ...args] = argv;
          const out = await sandbox.command(cmd, args, options).run({ check: false });
          return { exitCode: out.exitCode, stdout: out.stdout.text(), stderr: out.stderr.text() };
        },
        spawn: spawnOf(sandbox),
        async signal(signo) {
          if (!main) return void stopIdle?.();
          if (signo === 9) await main.kill();
          else await main.terminate({ gracePeriodMs: 2000 });
        },
        async destroy() {
          if (!running) return;
          if (main) await main.kill().catch(() => {});
          else stopIdle?.();
          await done;
        },
      };
      handles.add(handle);
      return handle;
    },
  };
}

/**
 * A Wasmer engine for a container worker: the guests' filesystem calls are forwarded to `files`,
 * where the pool serves the mounted FilesApis (serveHostFiles).
 */
export function wasmerWorkerEngine(wasmer: WasmerLike, files: PortLike): ContainerEngine {
  installHostFiles(forwardHostFiles(files));
  return wasmerContainerEngine(wasmer);
}
