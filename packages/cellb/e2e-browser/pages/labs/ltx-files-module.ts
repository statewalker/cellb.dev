// A FilesApi module for the store worker (`files: { module, args }`): built there from a
// directory handle the page posted (a File System Access handle works the same way).
import { BrowserFilesApi } from "@statewalker/webrun-files-browser";

export default function createFilesApi(args: { dir: FileSystemDirectoryHandle }) {
  return new BrowserFilesApi({ rootHandle: args.dir });
}

/** Free bytes there: unknown (compactions are not held back). */
export async function room() {
  return undefined;
}
