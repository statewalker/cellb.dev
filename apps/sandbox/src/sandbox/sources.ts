// Where a project's files are: any @statewalker/webrun-files FilesApi. The studio worker opens
// one per project and the capabilities filter it (the page edits, the build reads and the agents
// work through tokens on it). Descriptions are plain data, so the page can send one to a worker
// (a folder handle is structured-cloneable; an S3 key stays in the worker that opens it).
//
//   folder     a folder on the local disk (File System Access API handle)
//   memory     files held in the worker (a template, a ZIP, a branch opened from GitHub)
//   opfs       a folder in the origin's private file system: persistent, nothing to pick
//   s3         a bucket (or a prefix in one): AWS S3, R2, MinIO, RustFS… (the bucket must allow
//              CORS from this origin)
//   composite  one source at the root and others mounted at paths: the longest mount wins, so
//              `client/` can live on S3 while the rest is a local folder

import type { FilesApi } from "@statewalker/webrun-files";

export type SourceSpec =
  | { kind: "folder"; handle: FileSystemDirectoryHandle }
  | { kind: "memory"; files: [string, Uint8Array][] }
  | { kind: "opfs"; path: string }
  | {
      kind: "s3";
      bucket: string;
      prefix?: string;
      endpoint?: string;
      region?: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle?: boolean;
    }
  | { kind: "composite"; root: SourceSpec; mounts: { path: string; source: SourceSpec }[] };

/** A short label for people: where the files are. */
export function describeSource(spec: SourceSpec): string {
  switch (spec.kind) {
    case "folder":
      return `folder ${spec.handle.name}`;
    case "memory":
      return "memory (this tab)";
    case "opfs":
      return `browser storage /${spec.path.replace(/^\/+/, "")}`;
    case "s3":
      return `s3://${spec.bucket}/${(spec.prefix ?? "").replace(/^\/+/, "")}`;
    case "composite":
      return `${describeSource(spec.root)} + ${spec.mounts.map((m) => `${m.path} → ${describeSource(m.source)}`).join(", ")}`;
  }
}

async function opfsDir(path: string): Promise<FileSystemDirectoryHandle> {
  let dir = await navigator.storage.getDirectory();
  for (const name of path.split("/").filter(Boolean))
    dir = await dir.getDirectoryHandle(name, { create: true });
  return dir;
}

export async function openSource(spec: SourceSpec): Promise<FilesApi> {
  switch (spec.kind) {
    case "memory": {
      const { MemFilesApi } = await import("@statewalker/webrun-files-mem");
      const fs = new MemFilesApi();
      for (const [path, bytes] of spec.files) await fs.write(path, [bytes]);
      return fs;
    }
    case "folder": {
      const { BrowserFilesApi } = await import("@statewalker/webrun-files-browser");
      return new BrowserFilesApi({ rootHandle: spec.handle });
    }
    case "opfs": {
      const { BrowserFilesApi } = await import("@statewalker/webrun-files-browser");
      return new BrowserFilesApi({ rootHandle: await opfsDir(spec.path) });
    }
    case "s3": {
      const [{ S3Client }, { S3FilesApi }] = await Promise.all([
        import("@aws-sdk/client-s3"),
        import("@statewalker/webrun-files-s3"),
      ]);
      const client = new S3Client({
        region: spec.region || "auto",
        endpoint: spec.endpoint || undefined,
        forcePathStyle: spec.forcePathStyle ?? !!spec.endpoint,
        credentials: { accessKeyId: spec.accessKeyId, secretAccessKey: spec.secretAccessKey },
      });
      return new S3FilesApi({ client, bucket: spec.bucket, prefix: spec.prefix || undefined });
    }
    case "composite": {
      const { CompositeFilesApi } = await import("@statewalker/webrun-files-composite");
      const fs = new CompositeFilesApi(await openSource(spec.root));
      for (const m of spec.mounts) fs.mount(m.path, await openSource(m.source));
      return fs;
    }
  }
}
