// The project's files: a collapsible tree with the server and client parts marked, and the edits
// a file manager has: new file, new folder, rename or move (a path field, or drag a row onto a
// folder), delete. The edits themselves are the parent's (workspace.ts, and the disk).

import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { allDirs, checkPath, intoDir, parentOf, type Workspace } from "@/sandbox/workspace";

interface TreeRow {
  path: string;
  name: string;
  depth: number;
  dir: boolean;
}

/** Folders first, then files, each sorted by name; a folder row before its contents. */
export function treeRows(files: string[], dirs: Iterable<string>): TreeRow[] {
  type Node = { dirs: Map<string, Node>; files: string[] };
  const root: Node = { dirs: new Map(), files: [] };
  const nodeAt = (parts: string[]) => {
    let n = root;
    for (const d of parts) {
      if (!n.dirs.has(d)) n.dirs.set(d, { dirs: new Map(), files: [] });
      n = n.dirs.get(d) as Node;
    }
    return n;
  };
  for (const d of dirs) nodeAt(d.split("/").filter(Boolean));
  for (const p of files) nodeAt(p.split("/").filter(Boolean).slice(0, -1)).files.push(p);
  const rows: TreeRow[] = [];
  const walk = (n: Node, prefix: string, depth: number) => {
    for (const [name, child] of [...n.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      rows.push({ path: `${prefix}/${name}`, name, depth, dir: true });
      walk(child, `${prefix}/${name}`, depth + 1);
    }
    for (const f of n.files.sort())
      rows.push({ path: f, name: f.slice(f.lastIndexOf("/") + 1), depth, dir: false });
  };
  walk(root, "", 0);
  return rows;
}

type Editing =
  | { mode: "file" | "folder"; value: string }
  | { mode: "move"; from: string; value: string };

const DRAG_TYPE = "application/x-sandbox-path";

export function FileTree(props: {
  ws: Workspace;
  clientRoot?: string;
  serverFiles: Set<string>;
  selected?: string;
  dirty: Set<string>;
  collapsed: Set<string>;
  onToggle(dir: string): void;
  onCollapseAll(dirs: string[]): void;
  onSelect(path: string): void;
  onCreateFile(path: string): Promise<void>;
  onCreateDir(path: string): Promise<void>;
  onMove(from: string, to: string): Promise<void>;
  onDelete(path: string): Promise<void>;
}) {
  const dirs = allDirs(props.ws);
  const rows = treeRows([...props.ws.files.keys()], dirs);
  const [editing, setEditing] = useState<Editing>();
  const [error, setError] = useState<string>();
  const [dropDir, setDropDir] = useState<string>();
  const field = useRef<HTMLInputElement>(null);

  // Which edit the path field is for: focused (name selected) when it changes, not on each key.
  const editKey = !editing ? "" : "from" in editing ? `move:${editing.from}` : editing.mode;
  useEffect(() => {
    if (!editKey) return;
    field.current?.focus();
    // Select the name, not the folders before it.
    const v = field.current?.value ?? "";
    field.current?.setSelectionRange(v.lastIndexOf("/") + 1, v.length);
  }, [editKey]);

  // New things go where the selection is: the selected folder, or the selected file's folder.
  const base = () => {
    const s = props.selected;
    const dir = !s ? "/" : dirs.has(s) ? s : parentOf(s);
    return dir === "/" ? "" : `${dir.slice(1)}/`;
  };

  const hidden = (path: string) => {
    for (let d = parentOf(path); d !== "/"; d = parentOf(d))
      if (props.collapsed.has(d)) return true;
    return false;
  };

  const inClient = (p: string) =>
    !!props.clientRoot &&
    (props.clientRoot === "/" || p === props.clientRoot || p.startsWith(`${props.clientRoot}/`));
  const roleOf = (p: string) =>
    props.serverFiles.has(p) ? "server" : inClient(p) ? "client" : undefined;

  async function submit() {
    if (!editing) return;
    try {
      const path = checkPath(editing.value);
      if (editing.mode === "file") await props.onCreateFile(path);
      else if (editing.mode === "folder") await props.onCreateDir(path);
      else if ("from" in editing) await props.onMove(editing.from, path);
      setEditing(undefined);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function dropInto(dir: string, e: React.DragEvent) {
    e.preventDefault();
    setDropDir(undefined);
    const from = e.dataTransfer.getData(DRAG_TYPE);
    if (!from) return;
    const to = intoDir(dir, from);
    if (to === from) return;
    try {
      await props.onMove(from, to);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const dropTarget = (dir: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setDropDir(dir);
    },
    onDragLeave: () => setDropDir((d) => (d === dir ? undefined : d)),
    onDrop: (e: React.DragEvent) => {
      e.stopPropagation();
      void dropInto(dir, e);
    },
  });

  const label =
    editing?.mode === "file"
      ? "New file"
      : editing?.mode === "folder"
        ? "New folder"
        : editing && "from" in editing
          ? `Move or rename ${editing.from.slice(1)}`
          : "";

  return (
    <nav aria-label="Project files" className="flex min-h-full flex-col" {...dropTarget("/")}>
      <div className="bg-background sticky top-0 z-10 flex items-center gap-0.5 border-b px-2 py-1">
        <span className="text-muted-foreground mr-auto px-1 text-xs font-medium tracking-wide uppercase">
          Files
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="New file"
          title="New file"
          onClick={() => {
            setError(undefined);
            setEditing({ mode: "file", value: `${base()}untitled.ts` });
          }}
        >
          <FilePlus2 />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="New folder"
          title="New folder"
          onClick={() => {
            setError(undefined);
            setEditing({ mode: "folder", value: `${base()}folder` });
          }}
        >
          <FolderPlus />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Collapse all folders"
          title="Collapse all folders"
          onClick={() => props.onCollapseAll([...dirs])}
        >
          <ChevronsDownUp />
        </Button>
      </div>

      {editing && (
        <form
          className="border-b px-2 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="text-muted-foreground mb-1 block truncate text-xs" htmlFor="tree-path">
            {label}
          </label>
          <input
            id="tree-path"
            ref={field}
            aria-label={label}
            value={editing.value}
            spellCheck={false}
            onChange={(e) => setEditing({ ...editing, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setEditing(undefined);
                setError(undefined);
              }
            }}
            className="bg-background focus:ring-ring/40 h-7 w-full rounded-md border px-2 font-mono text-xs outline-none focus:ring-2"
          />
          {error && (
            <p role="alert" className="text-destructive mt-1 text-xs">
              {error}
            </p>
          )}
          <p className="text-muted-foreground mt-1 text-[11px]">Enter to apply, Esc to cancel</p>
        </form>
      )}
      {!editing && error && (
        <p role="alert" className="text-destructive border-b px-3 py-1.5 text-xs">
          {error}
        </p>
      )}

      <ul className="flex-1 py-1 font-mono text-[13px]">
        {rows.map((r) => {
          if (hidden(r.path)) return null;
          const role = roleOf(r.path);
          const open = !props.collapsed.has(r.path);
          const selected = props.selected === r.path;
          const name = r.path.slice(1);
          const dirty = props.dirty.has(r.path);
          // What a screen reader says for the row: its kind, path, part of the app, state.
          const spoken = [
            `${r.dir ? "Folder" : "File"} ${name}`,
            role === "server" && "server",
            role === "client" && r.path === props.clientRoot && "client",
            dirty && "unsaved",
          ]
            .filter(Boolean)
            .join(", ");
          const drag = {
            draggable: true,
            onDragStart: (e: React.DragEvent) => {
              e.dataTransfer.setData(DRAG_TYPE, r.path);
              e.dataTransfer.effectAllowed = "move";
            },
          };
          const action =
            "text-muted-foreground inline-flex size-7 items-center justify-center rounded focus-visible:ring-2 focus-visible:ring-ring/50 outline-none";
          return (
            <li
              key={r.path}
              {...(r.dir ? dropTarget(r.path) : {})}
              className={cn(
                "group flex items-center border-l-2 border-transparent pr-1",
                role === "server" && "border-l-accent-2",
                role === "client" && "border-l-primary/60",
                selected
                  ? r.dir
                    ? "bg-accent/60"
                    : "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50",
                dropDir === r.path && "bg-primary/10 ring-primary/40 ring-1 ring-inset",
              )}
              style={{ paddingLeft: `${4 + r.depth * 14}px` }}
            >
              {r.dir ? (
                <button
                  type="button"
                  className={cn(action, "size-6 shrink-0")}
                  aria-expanded={open}
                  aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
                  onClick={() => props.onToggle(r.path)}
                >
                  {open ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                </button>
              ) : (
                <span className="size-6 shrink-0" aria-hidden />
              )}
              <button
                type="button"
                {...drag}
                aria-label={spoken}
                aria-current={selected ? "true" : undefined}
                title={role ? `${name} (${role})` : name}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1.5 rounded py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  r.dir && "text-muted-foreground",
                )}
                onClick={() => {
                  props.onSelect(r.path);
                  // Selecting a folder opens it (it never closes it: the chevron does that).
                  if (r.dir && !open) props.onToggle(r.path);
                }}
              >
                {r.dir &&
                  (open ? (
                    <FolderOpen className="size-3.5 shrink-0" aria-hidden />
                  ) : (
                    <Folder className="size-3.5 shrink-0" aria-hidden />
                  ))}
                <span className="truncate">{r.name}</span>
                {dirty && (
                  <span
                    className="bg-primary size-1.5 shrink-0 rounded-full"
                    title="Unsaved changes"
                  />
                )}
                {role === "client" && r.path === props.clientRoot && (
                  <span className="text-primary font-sans text-[11px]">client</span>
                )}
                {role === "server" && !r.dir && (
                  <span className="text-accent-2 shrink-0 font-sans text-[11px]">server</span>
                )}
              </button>
              {/* Shown on hover and focus with a mouse; always on touch screens. */}
              <span className="flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                <button
                  type="button"
                  className={cn(action, "hover:text-foreground")}
                  aria-label={`Move or rename ${name}`}
                  title="Move or rename"
                  onClick={() => {
                    setError(undefined);
                    setEditing({ mode: "move", from: r.path, value: name });
                  }}
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  className={cn(action, "hover:text-destructive")}
                  aria-label={`Delete ${name}`}
                  title="Delete"
                  onClick={() => {
                    const what = r.dir ? `the folder ${name} and everything in it` : name;
                    if (!confirm(`Delete ${what}?`)) return;
                    props.onDelete(r.path).catch((err) => setError((err as Error).message));
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
