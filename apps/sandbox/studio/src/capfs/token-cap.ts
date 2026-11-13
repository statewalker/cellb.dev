// studio: the token transport, holder side. A capability is a Biscuit token; each call is an
// HTTP request to the studio (`POST /api/fs/:workspace`), which the Workspace cell authorizes
// with the token's Datalog, the session's mode and its revocations. A token can be stored,
// sent to another worker or node, and attenuated offline (one more Biscuit block).
//
// `files(cap)` (CapFilesApi) turns it into a @statewalker/webrun-files FilesApi: the page edits
// through one, the build reads through one, other agents' tools work through one.

import { Biscuit } from "@statewalker/webrun-biscuit";
import type { ModelAction, ModelUsage, ReadTreeOptions, TreeEntry } from "./authority.ts";
import { CapFilesApi } from "./cap-files-api.ts";
import type { Cap } from "./caps.ts";
import { rebuildError } from "./path.ts";
import { decodeWire, encodeWire } from "./wire.ts";

/** Sends one HTTP request to the studio (over a MessagePort, a fetch, an HTTPeers mount…). */
export type StudioSend = (request: Request) => Promise<Response>;

export class TokenCap implements Cap {
  readonly workspace: string;
  readonly token: string;
  #send: StudioSend;
  constructor(send: StudioSend, workspace: string, token: string) {
    this.#send = send;
    this.workspace = workspace;
    this.token = token;
  }
  async #call(req: Record<string, unknown>): Promise<unknown> {
    const res = await this.#send(
      new Request(`http://studio/api/fs/${encodeURIComponent(this.workspace)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(encodeWire({ token: this.token, req })),
      }),
    );
    const data = (await res.json()) as { value?: unknown; error?: string };
    if (res.status >= 400) throw rebuildError(new Error(data.error ?? `HTTP ${res.status}`));
    return decodeWire(data.value);
  }
  call(method: string, path: string, ...args: unknown[]) {
    return this.#call({ op: "call", method, path, args });
  }
  readdir(path: string) {
    return this.#call({ op: "readdir", path }) as Promise<string[]>;
  }
  move(kind: "cp" | "mv", src: string, dst: string, opts?: unknown) {
    return this.#call({ op: "move", kind, path: src, dst, opts }) as Promise<void>;
  }
  async attenuate(datalog: string): Promise<TokenCap> {
    const token = Biscuit.fromBase64(this.token).attenuate(datalog).toBase64();
    return new TokenCap(this.#send, this.workspace, token);
  }
  revocationId() {
    return this.#call({ op: "revocationId" }) as Promise<string>;
  }
  model(action: ModelAction, metered: boolean, usage?: ModelUsage) {
    return this.#call({ op: "model", action, metered, usage });
  }
  /** The subtree as this capability sees it, in one call (see FsGate.readTree). */
  readTree(path: string, opts: ReadTreeOptions = {}) {
    return this.call("readTree", path, opts) as Promise<TreeEntry[]>;
  }
}

export const files = (cap: Cap) => new CapFilesApi(cap);
