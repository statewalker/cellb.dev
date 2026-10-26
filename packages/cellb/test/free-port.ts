import { createServer, type Server } from "node:net";

/**
 * TCP ports on 127.0.0.1 that were free a moment ago: the OS picks them (listen on 0), the
 * listeners close, the caller binds them. Lets several runs (worktrees) share one machine.
 * All `n` listeners stay open until each has its port, so the ports are distinct.
 */
export async function freePorts(n: number): Promise<number[]> {
  const servers: Server[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
    }
    return servers.map((s) => (s.address() as { port: number }).port);
  } finally {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  }
}

export const freePort = async (): Promise<number> => (await freePorts(1))[0];
