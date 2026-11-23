import { createServer, type Server } from "node:net";

/**
 * TCP ports on 127.0.0.1 that were free a moment ago, for a process to bind: lets several runs
 * (worktrees) share one machine. All `n` listeners stay open until each has its port, so the
 * ports are distinct. They are picked below Linux's ephemeral range (32768–60999): a port the OS
 * hands out for `listen(0)` comes from that range, which every outgoing connection (to the S3
 * server, between nodes) also draws its local port from, so one could take it between this
 * check and the bind ("Address already in use", statewalker/cellb.dev#228).
 */
export async function freePorts(n: number): Promise<number[]> {
  const servers: Server[] = [];
  const listen = (server: Server, port: number) =>
    new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
  try {
    for (let i = 0; i < n; i++) {
      let server = createServer();
      for (let tries = 0; ; tries++) {
        const port = tries < 50 ? 20_000 + Math.floor(Math.random() * 12_768) : 0;
        if (await listen(server, port)) break;
        server = createServer();
      }
      servers.push(server);
    }
    return servers.map((s) => (s.address() as { port: number }).port);
  } finally {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  }
}

export const freePort = async (): Promise<number> => (await freePorts(1))[0];
