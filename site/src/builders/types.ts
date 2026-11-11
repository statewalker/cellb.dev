/**
 * What `scripts/record-builders.ts` writes to `src/builders/recorded/<kind>.json`: each example's
 * requests to the platform and the platform's answers, as they happened, and the screenshots it
 * took of the pages the examples produced.
 */

export interface RecordedStep {
  /** What the step does, in a few words. */
  title: string;
  /** Why it matters; shown under the title. */
  note?: string;
  /** The same request as a shell command. */
  curl: string;
  request: { method: string; url: string; body?: string };
  response: {
    status: number;
    /** The headers that tell something (location, content-type, cache-control, …). */
    headers: Record<string, string>;
    /** The body as text, cut to a readable length; `bodyLang` says how to highlight it. */
    body: string;
    bodyLang: string;
    /** The whole body's size. */
    bytes: number;
    /** How long the platform took to answer, measured by the client. */
    ms: number;
  };
}

export interface RecordedShot {
  /** Under `public/`, e.g. `/builders/esm-cdn.png`. */
  src: string;
  alt: string;
  /** The image's size in pixels (taken at deviceScaleFactor 2). */
  width: number;
  height: number;
  caption: string;
  /** What the browser did on the page, checked before the screenshot. */
  checks: string[];
}

export interface Recorded {
  kind: string;
  /** ISO date of the run. */
  recordedAt: string;
  /** Where the platform ran. */
  host: string;
  steps: RecordedStep[];
  shots: RecordedShot[];
  /** Named values the page quotes in its prose (a build id, a module count, …). */
  facts: Record<string, string | number>;
}
