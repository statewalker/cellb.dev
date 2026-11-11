// studio: capability calls as JSON. Bytes travel as { $b64 } (a request or an answer may hold
// Uint8Arrays: file contents, chunks); everything else is plain JSON.

export function encodeWire(v: unknown): unknown {
  if (v instanceof Uint8Array) {
    let s = "";
    for (let i = 0; i < v.length; i += 0x8000)
      s += String.fromCharCode(...v.subarray(i, i + 0x8000));
    return { $b64: btoa(s) };
  }
  if (v instanceof ArrayBuffer) return encodeWire(new Uint8Array(v));
  if (Array.isArray(v)) return v.map(encodeWire);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = encodeWire(x);
    return out;
  }
  return v;
}

export function decodeWire(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeWire);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$b64 === "string" && Object.keys(o).length === 1)
      return Uint8Array.from(atob(o.$b64), (c) => c.charCodeAt(0));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = decodeWire(x);
    return out;
  }
  return v;
}
