/**
 * A trace of a build, step by step: what was read, which packages were fetched (and at which
 * version, how long it took), how each specifier resolved, what each transform produced, what
 * the bundle contains. Every step of the builder records into it; `steps()` groups the events
 * for a report. Runs anywhere (no Node APIs); writing it out is the caller's business.
 */
export type TraceStep =
  | "sources"
  | "packages"
  | "config"
  | "integrations"
  | "routes"
  | "resolve"
  | "transform"
  | "virtual"
  | "bundle"
  | "run";

export interface TraceEvent {
  step: TraceStep;
  /** ms since the trace started. */
  t: number;
  /** ms the operation took, when it has a duration. */
  ms?: number;
  what: string;
  data?: Record<string, unknown>;
}

export class Trace {
  readonly events: TraceEvent[] = [];
  readonly #t0 = performance.now();
  constructor(readonly echo?: (e: TraceEvent) => void) {}

  add(step: TraceStep, what: string, data?: Record<string, unknown>, ms?: number): void {
    const e: TraceEvent = {
      step,
      t: Math.round(performance.now() - this.#t0),
      what,
      ...(ms !== undefined ? { ms: Math.round(ms) } : {}),
      ...(data ? { data } : {}),
    };
    this.events.push(e);
    this.echo?.(e);
  }

  /** Times `fn` as one event. */
  async time<T>(
    step: TraceStep,
    what: string,
    fn: () => Promise<T>,
    data?: (r: T) => Record<string, unknown>,
  ): Promise<T> {
    const t = performance.now();
    try {
      const r = await fn();
      this.add(step, what, data?.(r), performance.now() - t);
      return r;
    } catch (err) {
      this.add(
        step,
        `${what} FAILED`,
        { error: String((err as Error)?.message ?? err).slice(0, 2000) },
        performance.now() - t,
      );
      throw err;
    }
  }

  steps(): Record<string, TraceEvent[]> {
    const out: Record<string, TraceEvent[]> = {};
    for (const e of this.events) {
      out[e.step] ??= [];
      out[e.step].push(e);
    }
    return out;
  }
}

/**
 * The resolution graph of a bundle from esbuild's metafile: every import, with the specifier
 * as written (`original`) and the file it resolved to, grouped by importer.
 */
export function resolutionTrace(metafile: {
  inputs: Record<
    string,
    {
      bytes: number;
      imports: { path: string; kind: string; original?: string; external?: boolean }[];
    }
  >;
}) {
  const edges: {
    importer: string;
    specifier: string;
    resolved: string;
    kind: string;
    external?: boolean;
  }[] = [];
  for (const [importer, input] of Object.entries(metafile.inputs))
    for (const i of input.imports)
      edges.push({
        importer,
        specifier: i.original ?? i.path,
        resolved: i.path,
        kind: i.kind,
        ...(i.external ? { external: true } : {}),
      });
  return edges;
}

/** Bytes of the bundle's inputs, by package (`npm:<name>@<version>`), project (`~`) or namespace. */
export function inputsByPackage(metafile: { inputs: Record<string, { bytes: number }> }) {
  const by = new Map<string, { files: number; bytes: number }>();
  for (const [id, input] of Object.entries(metafile.inputs)) {
    const plain = id.replace(/^[a-z-]+:(?=~|npm:)/, "");
    const key = plain.startsWith("npm:")
      ? plain.slice(0, plain.indexOf("/", plain.indexOf("@", 5)))
      : plain.startsWith("~")
        ? "~ (project)"
        : `${id.split(":")[0]}: (virtual)`;
    const e = by.get(key) ?? { files: 0, bytes: 0 };
    e.files++;
    e.bytes += input.bytes;
    by.set(key, e);
  }
  return [...by].map(([pkg, v]) => ({ pkg, ...v })).sort((a, b) => b.bytes - a.bytes);
}
