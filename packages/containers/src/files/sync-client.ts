// A synchronous client of the host-filesystem protocol, for runtimes whose filesystem hooks are
// synchronous (Lifo's MountProvider): it posts a request and blocks on Atomics.wait until the
// thread that owns the FilesApi (serveHostFiles) writes the reply. Never call it on that thread:
// it would wait for itself. Needs SharedArrayBuffer (cross-origin isolation in browsers).
import type { PortLike } from "../rpc.ts";
import { HOST_FS_MESSAGE } from "./bridge.ts";

export type SyncFilesCall = (method: string, args: unknown[]) => unknown;

const RESPONSE_BYTES = 512 * 1024;
const HEADER_BYTES = 8;
const TIMEOUT_MS = 30_000;

export function syncHostFiles(port: PortLike, mount: number): SyncFilesCall {
  let response: SharedArrayBuffer | undefined;
  return (method, args) => {
    // One call at a time per thread (the caller blocks), so the reply buffer is reused.
    if (!response) response = new SharedArrayBuffer(RESPONSE_BYTES);
    const buffer = response;
    const control = new Int32Array(buffer, 0, 2);
    control.fill(0);
    port.postMessage({
      type: HOST_FS_MESSAGE,
      mount,
      method,
      args,
      response: buffer,
      binary: true,
    });
    const deadline = Date.now() + TIMEOUT_MS;
    while (Atomics.load(control, 0) === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || Atomics.wait(control, 0, 0, remaining) === "timed-out") {
        response = undefined; // a late reply still owns this buffer
        throw Object.assign(new Error(`host filesystem ${method} timed out`), {
          code: "ETIMEDOUT",
        });
      }
    }
    const bytes = new Uint8Array(buffer, HEADER_BYTES, control[1]).slice();
    if (Atomics.load(control, 0) === 2) return bytes;
    const reply = JSON.parse(new TextDecoder().decode(bytes)) as {
      value?: unknown;
      error?: { code: string; message: string };
    };
    if (reply.error)
      throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    return reply.value;
  };
}
