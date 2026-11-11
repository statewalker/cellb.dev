// Vendored from statewalker-sandbox/apps/flue-capfs-do (2641939, 2026-11-11); changes marked "studio:".
// Datalog vocabulary: which file method is which operation, the host-side policy of each
// session mode, the authority block minted per session, and ready-made attenuation blocks.
//
// Facts provided by the authorizer on every call (always bound as parameters):
//   operation({op})    "read" | "list" | "write" | "model"
//   resource({path})   normalised absolute path + "/" ("/" for "model")
// "model" is driving the deployment's LLM (the `agent` task): allowed by a session's
// model_use(true) fact, in every mode, and narrowed by attenuation like any operation.
//   (the session is read from the token's authority block; the owner then loads THAT session's
//    mode and revocations, which is what binds a token to its session and workspace)
//
// Modes only ever restrict what the token's right($r) facts allow; attenuation blocks
// (checks) narrow further. No matching `allow` → deny.

export type Op = "read" | "list" | "write" | "model";

export const OPS: Record<string, Op> = {
  readFile: "read",
  readFileBuffer: "read",
  exists: "list",
  stat: "list",
  lstat: "list",
  readdir: "list",
  readdirStat: "list",
  readTree: "list", // studio: each entry is authorized again (read for files)
  realpath: "list",
  writeFile: "write",
  writeFileBuffer: "write",
  appendFile: "write",
  appendFileBuffer: "write",
  // Streams (chunks of any size): reads need read, writes need write, on every chunk.
  openRead: "read",
  readChunk: "read",
  closeRead: "read",
  openWrite: "write",
  writeChunk: "write",
  commitWrite: "write",
  abortWrite: "write",
  mkdir: "write",
  rm: "write",
  chmod: "write",
  utimes: "write",
};

// Listing an ANCESTOR of a right is allowed so `ls /` can show the allowed branches;
// readdir() then filters the children one by one.
const ANCESTOR_LIST = `allow if operation("list"), resource($p), right($r), $r.starts_with($p);`;

// The model right does not depend on the mode (modes are about files).
const MODEL = `allow if operation("model"), model_use(true);`;

export const MODES: Record<string, string> = {
  // Everything inside the user's rights.
  yolo: `
allow if operation($o), ["read","list","write"].contains($o), resource($p), right($r), $p.starts_with($r);
${ANCESTOR_LIST}
${MODEL}`,
  // Work freely, but only inside /proj/ (and read everything the rights allow).
  prototyping: `
allow if operation($o), ["read","list"].contains($o), resource($p), right($r), $p.starts_with($r);
allow if operation("write"), resource($p), $p.starts_with("/proj/"), right($r), $p.starts_with($r);
${ANCESTOR_LIST}
${MODEL}`,
  // Planning: read everything in rights, write only plan artefacts under /plans/.
  plan: `
allow if operation($o), ["read","list"].contains($o), resource($p), right($r), $p.starts_with($r);
allow if operation("write"), resource($p), $p.starts_with("/plans/"), right($r), $p.starts_with($r);
${ANCESTOR_LIST}
${MODEL}`,
  // Constrained: read-only.
  readonly: `
allow if operation($o), ["read","list"].contains($o), resource($p), right($r), $p.starts_with($r);
${ANCESTOR_LIST}
${MODEL}`,
};

export const isMode = (m: unknown): m is string => typeof m === "string" && Object.hasOwn(MODES, m);

const esc = (s: string) => JSON.stringify(String(s));
const dirRight = (r: string) => (r === "/" ? "/" : r.replace(/\/?$/, "/"));

/** Authority block for one session. Rights end with "/" (see asResource). */
export function authorityBlock(a: {
  user: string;
  session: string;
  rights: string[];
  model?: boolean;
}): string {
  return [
    `user(${esc(a.user)});`,
    `session(${esc(a.session)});`,
    ...a.rights.map((r) => `right(${esc(dirRight(r))});`),
    ...(a.model ? ["model_use(true);"] : []),
  ].join("\n");
}

// Ready-made attenuation blocks. A scope also lets the holder LIST the ancestors of its
// subtree (so `ls /` shows the one branch it has, as the mode policies do for rights).
const scopeBody = (prefix: string) => {
  const r = esc(dirRight(prefix));
  return `resource($p), $p.starts_with(${r}) or operation("list"), resource($p), ${r}.starts_with($p) or operation("model")`;
};
export const scopeTo = (prefix: string): string => `check if ${scopeBody(prefix)};`;
// Read-only is about files: the model stays usable (its file tools are read-only then too).
export const READ_ONLY = `check if operation($o), ["read","list","model"].contains($o);`;
export const NO_MODEL = `check if operation($o), $o != "model";`;

/** Attenuation from a JSON description: { scope?: string|string[], readOnly?: boolean }. */
export function attenuationBlock(spec: {
  scope?: string | string[];
  readOnly?: boolean;
  noModel?: boolean;
  datalog?: string;
}): string {
  const lines: string[] = [];
  const scopes =
    spec.scope === undefined ? [] : Array.isArray(spec.scope) ? spec.scope : [spec.scope];
  if (scopes.length === 1) lines.push(scopeTo(scopes[0] as string));
  else if (scopes.length > 1) {
    // One check, several alternatives: `check if A or B` is written as several bodies.
    lines.push(`check if ${scopes.map(scopeBody).join(" or ")};`);
  }
  if (spec.readOnly) lines.push(READ_ONLY);
  if (spec.noModel) lines.push(NO_MODEL);
  if (spec.datalog) lines.push(spec.datalog);
  if (lines.length === 0) throw new Error("EINVAL: empty attenuation");
  return lines.join("\n");
}

/**
 * studio: the project's history stays the owner's: agents and tools never see the sandbox's
 * history (`.cellb/`) or the project's own repository (`.git/`).
 */
export const NO_GIT = `check if resource($p), !$p.starts_with("/.git/"), !$p.starts_with("/.cellb/");`;
