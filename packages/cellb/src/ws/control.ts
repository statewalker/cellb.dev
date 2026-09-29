/**
 * Control channel of a shard link: a raw MessagePort next to the HTTP links,
 * used for what HTTP-over-Duplex cannot carry — transferring WebSocket ports.
 *
 * Messages (the port rides in the payload so this works in browsers and Node):
 *   router → shard   { t: "ws-connect", id, url, protocols, headers }
 *   shard  → router  { t: "ws-accept", id, protocol, port }   (reply, or cross-shard hand-over)
 *   shard  → router  { t: "ws-refuse", id, message }
 * Ids: "r:<n>" = opened by the router (a page's socket); "s<shard>:<n>" = opened by a
 * Worker running in shard <shard> through a stub in another shard.
 */
export interface ControlPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  start?(): void;
}

export type ControlMessage =
  | { t: "ws-connect"; id: string; url: string; protocols: string[]; headers?: [string, string][] }
  | { t: "ws-accept"; id: string; protocol?: string; port: MessagePort }
  | { t: "ws-refuse"; id: string; message: string };

/** Shard that must receive a control message addressed by id, or undefined for the router. */
export function shardOfControlId(id: string): number | undefined {
  const m = /^s(\d+):/.exec(id);
  return m ? Number(m[1]) : undefined;
}

/** Waits for ports by id; tolerates a port arriving before anyone waits for it. */
export class PortRendezvous {
  #arrived = new Map<string, { port: MessagePort; protocol?: string } | Error>();
  #waiting = new Map<
    string,
    { resolve: (v: { port: MessagePort; protocol?: string }) => void; reject: (e: Error) => void }
  >();

  deliver(id: string, value: { port: MessagePort; protocol?: string } | Error): void {
    const w = this.#waiting.get(id);
    if (!w) return void this.#arrived.set(id, value);
    this.#waiting.delete(id);
    value instanceof Error ? w.reject(value) : w.resolve(value);
  }

  wait(id: string, timeoutMs = 15_000): Promise<{ port: MessagePort; protocol?: string }> {
    const early = this.#arrived.get(id);
    if (early) {
      this.#arrived.delete(id);
      return early instanceof Error ? Promise.reject(early) : Promise.resolve(early);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new Error(`WebSocket port ${id} did not arrive within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#waiting.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
    });
  }

  /** Fails every waiter whose id matches (e.g. its shard's owner is gone). */
  failAll(match: (id: string) => boolean, error: Error): void {
    for (const [id, w] of [...this.#waiting]) {
      if (!match(id)) continue;
      this.#waiting.delete(id);
      w.reject(error);
    }
  }
}
