// What an agent cell holds: the capability, as an RPC stub of the owner's FilteredFiles.
// Adapted from statewalker-sandbox/apps/flue-capfs-do/src/caps.ts (studio: the stub transport
// only; the token transport is for cells on other nodes).

import type { ModelAction, ModelUsage } from "./authority.ts";
import { rebuildError } from "./path.ts";

export interface Cap {
  call(method: string, path: string, ...args: unknown[]): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  move(kind: "cp" | "mv", src: string, dst: string, opts?: unknown): Promise<void>;
  attenuate(datalog: string): Promise<Cap>;
  revocationId(): Promise<string>;
  model(action: ModelAction, metered: boolean, usage?: ModelUsage): Promise<unknown>;
}

/** The owner-side RpcTarget's methods, as a stub exposes them. */
export interface FilesStub {
  call(method: string, path: string, ...args: unknown[]): unknown;
  readdir(path: string): unknown;
  move(kind: "cp" | "mv", src: string, dst: string, opts?: unknown): unknown;
  attenuate(datalog: string): unknown;
  revocationId(): unknown;
  model(action: ModelAction, metered: boolean, usage?: ModelUsage): unknown;
}

const wrap = <T>(p: Promise<T>): Promise<T> =>
  p.catch((e) => {
    throw rebuildError(e);
  });

export class StubCap implements Cap {
  #stub: FilesStub;
  constructor(stub: FilesStub) {
    this.#stub = stub;
  }
  call(method: string, path: string, ...args: unknown[]) {
    return wrap(Promise.resolve(this.#stub.call(method, path, ...args)));
  }
  readdir(path: string) {
    return wrap(Promise.resolve(this.#stub.readdir(path))) as Promise<string[]>;
  }
  move(kind: "cp" | "mv", src: string, dst: string, opts?: unknown) {
    return wrap(Promise.resolve(this.#stub.move(kind, src, dst, opts))) as Promise<void>;
  }
  async attenuate(datalog: string): Promise<Cap> {
    return new StubCap((await wrap(Promise.resolve(this.#stub.attenuate(datalog)))) as FilesStub);
  }
  revocationId() {
    return wrap(Promise.resolve(this.#stub.revocationId())) as Promise<string>;
  }
  model(action: ModelAction, metered: boolean, usage?: ModelUsage) {
    return wrap(Promise.resolve(this.#stub.model(action, metered, usage)));
  }
}
