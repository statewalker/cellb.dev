// Wasmer's host-filesystem protocol served by a FilesApi.
import type { FilesApi } from "@statewalker/webrun-files";

export class FilesVolume {
  constructor(_files: FilesApi, _opts: { readOnly?: boolean } = {}) {}
  async request(_method: string, _args: unknown[]): Promise<unknown> {
    throw new Error("not implemented");
  }
}
