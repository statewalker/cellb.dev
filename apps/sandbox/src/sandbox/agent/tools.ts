// The sandbox's tools: one surface over the open project for people's scripts and for AI agents.
//
// Every action an agent needs to build an app here — read the files, change them, run the app,
// read its log, call it over HTTP — is a tool with a name, a description and a JSON Schema for
// its input, the shape MCP, WebMCP (`navigator.modelContext`) and model APIs share. The page
// implements `StudioHost` over a capability (a Biscuit token on the project's files, with the
// rights the person gives outside agents); `createTools(host)` turns it into tools; `bridge.ts`
// publishes them. Reads and writes both go through the capability: a scope or a read-only mode
// holds for these tools as it does for the Flue agent.
//
// Results are plain JSON (text for files), short enough for a model's context: listings and
// bodies are capped, and a cap that cuts says so.

import { normalizePath } from "../project";

export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface ToolSpec {
  name: string;
  /** For the model: what the tool does, when to use it, what it returns. */
  description: string;
  inputSchema: JsonSchema;
  /** True when the tool changes nothing (agents may call it without asking). */
  readOnly?: boolean;
}

export interface Tool extends ToolSpec {
  execute(args: Record<string, unknown>): Promise<unknown>;
}

export type RunState =
  | { kind: "empty" }
  | { kind: "building" }
  | { kind: "running"; baseUrl: string; server: boolean; client: boolean }
  | { kind: "failed"; error: string }
  | { kind: "stopped" };

export interface StudioLogLine {
  id: number;
  at: number;
  text: string;
  level: "info" | "error";
}

export interface StudioProject {
  name: string;
  /** Where the files are (a folder on disk, memory, OPFS, S3…). */
  source: string;
  /** The rights the tools hold (the capability's mode). */
  rights: string;
}

export interface TreeItem {
  path: string;
  size: number;
  dir?: boolean;
  data?: Uint8Array;
}

/** What the page gives the tools: the project through a capability, and its runner. */
export interface StudioHost {
  project(): StudioProject | undefined;
  /** The files (and empty folders) the capability may list; with contents when asked. */
  tree(opts?: { contents?: boolean }): Promise<TreeItem[]>;
  /** A file's bytes, or undefined when it does not exist (or is not visible). */
  read(path: string): Promise<Uint8Array | undefined>;
  /** Writes a file, making it (and its folders) when it is new. */
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  /** Runs the app again and resolves when it runs or fails. */
  run(): Promise<RunState>;
  stop(): Promise<void>;
  state(): RunState;
  logs(): StudioLogLine[];
  /** A request to the running app, from this page (its ServiceWorker answers). */
  fetchApp(path: string, init: RequestInit): Promise<Response>;
  /** Opens a file in the editor, for the person watching (optional). */
  reveal?(path: string): void;
}

export class ToolError extends Error {
  override name = "ToolError";
}

const MAX_TEXT = 200_000;
const MAX_LIST = 2000;
const MAX_BODY = 50_000;
const MAX_MATCHES = 200;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new ToolError(`"${key}" is required`);
    return "";
  }
  if (typeof v !== "string") throw new ToolError(`"${key}" must be a string`);
  return v;
}

/** A path from an agent: relative or absolute, never above the project's root. */
export function projectPath(input: string): string {
  const raw = input.trim().replace(/\\/g, "/");
  if (!raw) throw new ToolError("give a path");
  if (raw.split("/").includes("..")) throw new ToolError('".." is not allowed in a path');
  return normalizePath(`/${raw}`);
}

function needProject(host: StudioHost): StudioProject {
  const p = host.project();
  if (!p) throw new ToolError("no project is open: open a folder or a template first");
  return p;
}

async function readText(host: StudioHost, path: string): Promise<string> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await host.read(path);
  } catch (err) {
    throw new ToolError((err as Error).message);
  }
  if (!bytes) throw new ToolError(`${path.slice(1)} does not exist`);
  return textOf(path, bytes);
}

function textOf(path: string, bytes: Uint8Array): string {
  if (bytes.subarray(0, 8192).includes(0))
    throw new ToolError(`${path.slice(1)} is a binary file (${bytes.length} bytes)`);
  return decoder.decode(bytes);
}

/** "*.ts", "client/**", "**\/*.tsx" → a RegExp over paths without the leading "/". */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A pattern without "/" matches a name at any depth, as .gitignore does.
  return new RegExp(glob.includes("/") ? `^${re}$` : `(?:^|/)${re}$`);
}

function waitFor<T>(get: () => T | undefined, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const v = get();
      if (v !== undefined || Date.now() - t0 > ms) resolve(v);
      else setTimeout(tick, 100);
    };
    tick();
  });
}

export function createTools(host: StudioHost): Tool[] {
  const tools: Tool[] = [
    {
      name: "project_info",
      description:
        "Describes the open project: its name, whether edits reach the local disk, its file count, the run state (building, running with its URL, failed with the error), and the layout conventions (wrangler.jsonc + main for the server, client/index.html for the client). Call it first.",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
      async execute() {
        const p = host.project();
        const files = p ? (await host.tree()).filter((e) => !e.dir).length : 0;
        return {
          open: !!p,
          name: p?.name,
          source: p?.source,
          rights: p?.rights,
          files,
          state: host.state(),
          conventions: {
            server:
              "wrangler.jsonc with a `main` (a Worker: Durable Objects, KV, D1, R2, Queues, Workflows); npm imports come from package.json",
            client:
              "client/index.html (or public/, or the root) whose <script src> and <link href> name TS/TSX/JS/JSX/CSS, compiled in the browser",
            urls: "the client calls the server with relative URLs, e.g. fetch('api/items')",
            agents: "AGENTS.md at the root, when present, holds the project's own instructions",
          },
        };
      },
    },
    {
      name: "list_files",
      description:
        "Lists the project's files (paths relative to the root, with byte sizes). `pattern` is an optional glob such as `**/*.tsx` or `server/*`. node_modules, .git and build output are never loaded.",
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string", description: "glob, e.g. client/**/*.ts" } },
      },
      readOnly: true,
      async execute(args) {
        needProject(host);
        const pattern = str(args, "pattern", false);
        const re = pattern ? globToRegExp(pattern) : undefined;
        const tree = await host.tree();
        const all = tree
          .filter((e) => !e.dir)
          .map((e) => ({ path: e.path.slice(1), size: e.size }))
          .filter((f) => !re || re.test(f.path))
          .sort((a, b) => a.path.localeCompare(b.path));
        const dirs = tree.filter((e) => e.dir).map((e) => e.path);
        return {
          files: all.slice(0, MAX_LIST),
          emptyDirs: dirs
            .filter((d) => !tree.some((e) => !e.dir && e.path.startsWith(`${d}/`)))
            .map((d) => d.slice(1)),
          truncated: all.length > MAX_LIST,
        };
      },
    },
    {
      name: "read_file",
      description:
        "Reads a text file. Returns its content with the total line count; `offset` (1-based line) and `limit` (lines) read a part of a long file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number", description: "first line, 1-based" },
          limit: { type: "number", description: "number of lines" },
        },
        required: ["path"],
      },
      readOnly: true,
      async execute(args) {
        needProject(host);
        const path = projectPath(str(args, "path"));
        const text = await readText(host, path);
        const lines = text.split("\n");
        const offset = Math.max(1, Number(args.offset ?? 1) || 1);
        const limit = args.limit === undefined ? lines.length : Math.max(0, Number(args.limit));
        let content = lines.slice(offset - 1, offset - 1 + limit).join("\n");
        const truncated = content.length > MAX_TEXT;
        if (truncated) content = content.slice(0, MAX_TEXT);
        host.reveal?.(path);
        return { path: path.slice(1), lines: lines.length, offset, content, truncated };
      },
    },
    {
      name: "write_file",
      description:
        "Writes a whole text file, creating it and its folders when new. Prefer edit_file for a change inside an existing file. Call run_app when a change is complete.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      async execute(args) {
        needProject(host);
        const path = projectPath(str(args, "path"));
        const content = str(args, "content");
        await host.writeFile(path, encoder.encode(content));
        host.reveal?.(path);
        return { path: path.slice(1), bytes: encoder.encode(content).length };
      },
    },
    {
      name: "edit_file",
      description:
        "Replaces `old_text` with `new_text` in a file. `old_text` must occur exactly once (add surrounding lines to make it unique) unless `replace_all` is true.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_text", "new_text"],
      },
      async execute(args) {
        needProject(host);
        const path = projectPath(str(args, "path"));
        const text = await readText(host, path);
        const oldText = str(args, "old_text");
        const newText = str(args, "new_text");
        if (!oldText) throw new ToolError('"old_text" is empty: use write_file to write a file');
        const count = text.split(oldText).length - 1;
        if (count === 0) throw new ToolError(`old_text is not in ${path.slice(1)}`);
        if (count > 1 && args.replace_all !== true)
          throw new ToolError(
            `old_text occurs ${count} times in ${path.slice(1)}: make it unique or set replace_all`,
          );
        const next =
          args.replace_all === true
            ? text.split(oldText).join(newText)
            : text.replace(oldText, () => newText);
        await host.writeFile(path, encoder.encode(next));
        host.reveal?.(path);
        return { path: path.slice(1), replaced: args.replace_all === true ? count : 1 };
      },
    },
    {
      name: "search",
      description:
        "Searches the text files for a regular expression (JavaScript syntax, case-sensitive unless `ignore_case`). Returns matching lines as path:line: text. `pattern` narrows the files with a glob.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "a regular expression" },
          pattern: { type: "string", description: "glob of files to search" },
          ignore_case: { type: "boolean" },
        },
        required: ["query"],
      },
      readOnly: true,
      async execute(args) {
        needProject(host);
        let re: RegExp;
        try {
          re = new RegExp(str(args, "query"), args.ignore_case === true ? "i" : "");
        } catch (err) {
          throw new ToolError(`not a regular expression: ${(err as Error).message}`);
        }
        const glob = str(args, "pattern", false);
        const files = glob ? globToRegExp(glob) : undefined;
        const matches: string[] = [];
        const tree = (await host.tree({ contents: true })).filter((e) => !e.dir && e.data);
        for (const { path, data } of tree.sort((a, b) => a.path.localeCompare(b.path))) {
          const bytes = data as Uint8Array;
          if (files && !files.test(path.slice(1))) continue;
          if (bytes.subarray(0, 8192).includes(0)) continue;
          const lines = decoder.decode(bytes).split("\n");
          for (let i = 0; i < lines.length && matches.length <= MAX_MATCHES; i++)
            if (re.test(lines[i]))
              matches.push(`${path.slice(1)}:${i + 1}: ${lines[i].slice(0, 300)}`);
        }
        return { matches: matches.slice(0, MAX_MATCHES), truncated: matches.length > MAX_MATCHES };
      },
    },
    {
      name: "make_folder",
      description: "Makes an empty folder (and its parents).",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async execute(args) {
        needProject(host);
        const path = projectPath(str(args, "path"));
        await host.mkdir(path);
        return { path: path.slice(1) };
      },
    },
    {
      name: "delete_path",
      description:
        "Deletes a file, or a folder with everything in it. On a local folder this deletes on disk.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async execute(args) {
        needProject(host);
        const path = projectPath(str(args, "path"));
        await host.remove(path);
        return { deleted: path.slice(1) };
      },
    },
    {
      name: "move_path",
      description: "Renames or moves a file or a folder.",
      inputSchema: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
      },
      async execute(args) {
        needProject(host);
        const from = projectPath(str(args, "from"));
        const to = projectPath(str(args, "to"));
        await host.move(from, to);
        return { from: from.slice(1), to: to.slice(1) };
      },
    },
    {
      name: "run_app",
      description:
        "Builds and (re)starts the app: the server bundled and run on CellB, the client served. Waits until it runs or fails, then returns the state and the log lines of this run (bundling errors included).",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        needProject(host);
        const before = host.logs().at(-1)?.id ?? 0;
        const state = await host.run();
        return {
          state,
          log: host
            .logs()
            .filter((l) => l.id > before)
            .map((l) => `${l.level === "error" ? "ERROR " : ""}${l.text}`),
        };
      },
    },
    {
      name: "stop_app",
      description: "Stops the running app.",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        await host.stop();
        return { state: host.state() };
      },
    },
    {
      name: "read_logs",
      description:
        "Reads the log: builds, runs, server errors, client modules that fail to compile. `since` (a line id from an earlier call) returns only newer lines; `errors_only` keeps errors.",
      inputSchema: {
        type: "object",
        properties: { since: { type: "number" }, errors_only: { type: "boolean" } },
      },
      readOnly: true,
      async execute(args) {
        const since = Number(args.since ?? 0) || 0;
        const lines = host
          .logs()
          .filter((l) => l.id > since && (args.errors_only !== true || l.level === "error"));
        return {
          lines: lines.slice(-300).map(({ id, level, text }) => ({ id, level, text })),
          last: host.logs().at(-1)?.id ?? 0,
          state: host.state(),
        };
      },
    },
    {
      name: "http_request",
      description:
        "Sends an HTTP request to the running app, as its client would (relative path such as `api/items` or `/`). Returns status, headers and the body as text (capped). Use it to test the server's API.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          method: { type: "string", description: "GET by default" },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: { type: "string" },
        },
        required: ["path"],
      },
      readOnly: true,
      async execute(args) {
        const state = await waitFor(() => {
          const s = host.state();
          return s.kind === "building" ? undefined : s;
        }, 60_000);
        if (state?.kind !== "running")
          throw new ToolError(
            `the app is not running (${state?.kind ?? "building"}): call run_app`,
          );
        const method = (str(args, "method", false) || "GET").toUpperCase();
        const init: RequestInit = {
          method,
          headers: (args.headers as Record<string, string>) ?? undefined,
        };
        if (args.body !== undefined && method !== "GET" && method !== "HEAD")
          init.body = str(args, "body");
        const res = await host.fetchApp(str(args, "path").replace(/^\/+/, ""), init);
        let body = await res.text();
        const truncated = body.length > MAX_BODY;
        if (truncated) body = body.slice(0, MAX_BODY);
        return {
          status: res.status,
          headers: Object.fromEntries(res.headers),
          body,
          truncated,
        };
      },
    },
  ];
  return tools;
}

/** Calls a tool by name; errors come back as `{ error }` so a model can read them. */
export async function callTool(
  tools: Tool[],
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `no tool named ${name}` };
  try {
    return { ok: true, result: await tool.execute(args ?? {}) };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? String(err) };
  }
}

export const specsOf = (tools: Tool[]): ToolSpec[] =>
  tools.map(({ name, description, inputSchema, readOnly }) => ({
    name,
    description,
    inputSchema,
    readOnly,
  }));
