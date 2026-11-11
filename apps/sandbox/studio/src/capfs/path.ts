// Vendored from statewalker-sandbox/apps/flue-capfs-do (2641939, 2026-11-11); changes marked "studio:".
// Path rules shared by the owner (authorization) and the holders (adapters).
// - normalise(): absolute, no "." / "..". As in POSIX, "/.." is "/": tools walk up to the root
//   (rg looks for ignore files), and authorization always runs on the normalised path.
// - asResource(): the value bound to resource($p) in Datalog. A trailing "/" makes prefix
//   rights exact: right("/p1/") matches "/p1/x/" but never "/p10/".

export type FsErrorCode =
  | "EACCES"
  | "EFBIG"
  | "EMFILE"
  | "EBADF"
  | "ESTALE"
  | "ENOENT"
  | "EEXIST"
  | "EISDIR"
  | "ENOTDIR"
  | "ENOTEMPTY"
  | "EINVAL"
  | "ENOSYS"
  | "EPERM"
  | "EIO";

export interface FsError extends Error {
  code: string;
}

/** Every message starts with the code, so a holder can rebuild `code` from the message alone. */
export function fsError(code: FsErrorCode, message: string): FsError {
  const err = new Error(`${code}: ${message}`) as FsError;
  err.code = code;
  return err;
}

export function normalise(p: unknown): string {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0")) {
    throw fsError("EINVAL", `invalid path '${String(p)}'`);
  }
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

export const asResource = (path: string): string => (path === "/" ? "/" : `${path}/`);

export const join = (base: string, name: string): string =>
  base === "/" ? `/${name}` : `${base}/${name}`;

export const dirname = (path: string): string => {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
};

/** Rebuild `code` after a hop that may have dropped it (RPC, HTTP, isolate boundary). */
export function rebuildError(e: unknown): FsError {
  const message = String((e as Error)?.message ?? e);
  const code = (e as FsError)?.code ?? message.match(/^(E[A-Z]+)\b/)?.[1] ?? "EIO";
  const err = new Error(message) as FsError;
  err.code = code;
  return err;
}
