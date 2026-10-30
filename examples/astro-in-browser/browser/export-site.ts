/**
 * Exports the running site as static files: crawls it from `/` (same-origin links, and the
 * stylesheets, scripts and images pages reference), saves pages as `<path>/index.html` and
 * other responses under their path, and packs everything into a ZIP (stored, no compression).
 * The export is served by any static file server at the origin's root.
 */
const SKIP = /^\/(_emdash|__cellb|cellb-sw\.js)/;
const PAGE_LIMIT = 300;

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

/** A ZIP of `files` (path → bytes), stored. */
export function zip(files: Map<string, Uint8Array>): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [path, data] of files) {
    const name = enc.encode(path);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    const head = new Uint8Array(local.buffer);
    parts.push(head, name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += head.length + name.length + data.length;
  }
  const size = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.size, true);
  end.setUint16(10, files.size, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[], {
    type: "application/zip",
  });
}

/** Crawls the site served at this origin and returns its files. */
export async function crawlSite(
  log: (m: string) => void = () => {},
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const queue = ["/"];
  const seen = new Set(queue);
  const enqueue = (raw: string, base: string) => {
    let u: URL;
    try {
      u = new URL(raw, new URL(base, location.origin));
    } catch {
      return;
    }
    if (
      u.origin !== location.origin ||
      (SKIP.test(u.pathname) && !u.pathname.startsWith("/_emdash/api/media/file/"))
    )
      return;
    const p = u.pathname;
    if (!seen.has(p) && seen.size < PAGE_LIMIT) seen.add(p), queue.push(p);
  };
  while (queue.length) {
    const path = queue.shift() as string;
    const res = await fetch(path, { redirect: "follow" });
    if (!res.ok) continue;
    const type = res.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (type.includes("text/html")) {
      files.set(
        `${path.replace(/^\/|\/$/g, "") ? `${path.replace(/^\/|\/$/g, "")}/` : ""}index.html`,
        bytes,
      );
      const html = new TextDecoder().decode(bytes);
      for (const m of html.matchAll(/\s(?:href|src)="([^"#]+)"/g))
        enqueue(m[1].replaceAll("&amp;", "&"), path);
    } else {
      files.set(path.replace(/^\//, ""), bytes);
      if (type.includes("css"))
        for (const m of new TextDecoder().decode(bytes).matchAll(/url\(["']?([^"')]+)["']?\)/g))
          enqueue(m[1], path);
    }
    log(`exported ${path}`);
  }
  return files;
}
