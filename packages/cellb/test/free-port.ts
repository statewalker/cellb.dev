import { createServer } from "node:net";

/**
 * A TCP port on 127.0.0.1 that was free a moment ago: the OS picks it (listen on 0), the
 * listener closes, the caller binds it. Lets several runs (worktrees) share one machine.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}
