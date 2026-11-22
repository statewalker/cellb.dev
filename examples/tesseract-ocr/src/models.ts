/**
 * Tesseract language models (`<lang>.traineddata`), fetched once and kept in
 * the Durable Object's own SQLite, so a cell that restarts (or is evicted and
 * comes back) does not download them again. A SQLite row holds at most 2 MB
 * on Durable Objects: models are stored in 1 MiB chunks.
 */

const CHUNK = 1024 * 1024;
/** tessdata_fast models are 1–4 MB; tessdata_best up to ~15 MB. Larger is not a model. */
const MAX_MODEL_BYTES = 32 * 1024 * 1024;
const LANG = /^[a-z]{3}(_[a-z]+)?$/;

/** The SQL API of a Durable Object's storage (the part used here). */
export interface Sql {
  exec(
    query: string,
    ...bindings: unknown[]
  ): {
    toArray(): Record<string, unknown>[];
  };
}

export function initModelTable(sql: Sql): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS model_chunk (lang TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (lang, idx))",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS model (lang TEXT PRIMARY KEY, size INTEGER NOT NULL, sha256 TEXT NOT NULL, source TEXT NOT NULL)",
  );
}

export function checkLang(lang: string): string {
  if (!LANG.test(lang)) throw new Error(`EINVAL: bad language code '${lang}'`);
  return lang;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type ModelSource = "memory" | "sqlite" | "fetch";

/** Reads the model from SQLite, or fetches and stores it. */
export async function loadModel(
  sql: Sql,
  lang: string,
  baseUrl: string,
): Promise<{ bytes: Uint8Array; source: Exclude<ModelSource, "memory"> }> {
  const meta = sql.exec("SELECT size, sha256 FROM model WHERE lang = ?", lang).toArray()[0];
  if (meta) {
    const rows = sql
      .exec("SELECT data FROM model_chunk WHERE lang = ? ORDER BY idx", lang)
      .toArray();
    const bytes = new Uint8Array(Number(meta.size));
    let offset = 0;
    for (const r of rows) {
      const chunk = new Uint8Array(r.data as ArrayBuffer);
      // More chunks than the size says (left from an interrupted store): damaged, fetch again.
      if (offset + chunk.byteLength > bytes.byteLength) {
        offset = -1;
        break;
      }
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset === bytes.byteLength && (await sha256(bytes)) === meta.sha256) {
      return { bytes, source: "sqlite" };
    }
    // A damaged copy: fetch again.
    sql.exec("DELETE FROM model_chunk WHERE lang = ?", lang);
    sql.exec("DELETE FROM model WHERE lang = ?", lang);
  }

  const url = new URL(`${lang}.traineddata`, baseUrl).href;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`EIO: model ${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_MODEL_BYTES) throw new Error(`EIO: model ${url} is too large`);
  const digest = await sha256(bytes);
  // No await from here on: the chunks and the row are written in one synchronous run, and old
  // chunks of the language go first.
  sql.exec("DELETE FROM model_chunk WHERE lang = ?", lang);
  for (let i = 0; i * CHUNK < bytes.byteLength; i++) {
    sql.exec(
      "INSERT OR REPLACE INTO model_chunk (lang, idx, data) VALUES (?, ?, ?)",
      lang,
      i,
      bytes.subarray(i * CHUNK, (i + 1) * CHUNK),
    );
  }
  sql.exec(
    "INSERT OR REPLACE INTO model (lang, size, sha256, source) VALUES (?, ?, ?, ?)",
    lang,
    bytes.byteLength,
    digest,
    url,
  );
  return { bytes, source: "fetch" };
}

export function storedModels(sql: Sql) {
  return sql.exec("SELECT lang, size, source FROM model ORDER BY lang").toArray();
}
