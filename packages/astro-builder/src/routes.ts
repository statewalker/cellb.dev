/**
 * Routes of an Astro project's `src/pages`, as Astro's router names them: a file is a page
 * (`.astro`) or an endpoint (`.ts`/`.js`), `[x]` a parameter, `[...x]` a rest parameter, and
 * `index` the directory itself. The result is Astro's serialized `RouteData`.
 */
import type { FilesApi } from "@statewalker/webrun-files";

export interface Segment {
  content: string;
  dynamic: boolean;
  spread: boolean;
}

export interface RouteData {
  route: string;
  component: string;
  type: "page" | "endpoint";
  params: string[];
  segments: Segment[][];
  pattern: string;
  pathname?: string;
  isIndex: boolean;
  prerender: boolean;
  fallbackRoutes: never[];
  distURL: never[];
  origin: "project" | "internal" | "external";
  _meta: { trailingSlash: "ignore" };
}

const PAGE = /\.(astro|ts|js|mjs)$/;

async function* walk(files: FilesApi, dir: string): AsyncGenerator<string> {
  for await (const e of files.list(dir)) {
    if (e.kind === "directory") yield* walk(files, e.path);
    else yield e.path;
  }
}

/** One path segment (`[slug]`, `sitemap-[collection].xml`) as Astro's parts. */
function parseSegment(seg: string): Segment[] {
  const parts: Segment[] = [];
  for (const m of seg.matchAll(/\[([^\]]+)\]|([^[]+)/g)) {
    if (m[1]) {
      const spread = m[1].startsWith("...");
      parts.push({ content: m[1], dynamic: true, spread });
    } else parts.push({ content: m[2], dynamic: false, spread: false });
  }
  return parts;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Astro's route pattern for its segments (trailingSlash "ignore"). */
function patternOf(segments: Segment[][], endpointWithExt: boolean): string {
  let re = "";
  for (const seg of segments) {
    if (seg.length === 1 && seg[0].spread) {
      re += "(?:\\/(.*?))?";
      continue;
    }
    re += "\\/";
    for (const p of seg) {
      if (!p.dynamic) re += escapeRe(p.content);
      else re += p.spread ? "(.*?)" : "([^/]+?)";
    }
  }
  if (!re) return "^\\/$";
  return `^${re}${endpointWithExt ? "$" : "\\/?$"}`;
}

/** The routes of `root/src/pages`, ordered as Astro matches them: static before dynamic. */
export async function projectRoutes(files: FilesApi, root: string): Promise<RouteData[]> {
  const base = `${root.replace(/\/$/, "")}/src/pages`;
  const routes: RouteData[] = [];
  for await (const path of walk(files, base)) {
    const rel = path.slice(base.length + 1);
    if (!PAGE.test(rel) || rel.split("/").some((s) => s.startsWith("_"))) continue;
    const type = rel.endsWith(".astro") ? "page" : "endpoint";
    const noExt = rel.replace(PAGE, "");
    const parts = noExt.split("/");
    const isIndex = parts.at(-1) === "index";
    if (isIndex) parts.pop();
    const segments = parts.map(parseSegment);
    const params = segments
      .flat()
      .filter((p) => p.dynamic)
      .map((p) => p.content);
    const route = `/${parts.join("/")}`;
    const hasExt = type === "endpoint" && /\.[a-z0-9]+$/i.test(parts.at(-1) ?? "");
    routes.push({
      route,
      component: `src/pages/${rel}`,
      type,
      params,
      segments,
      pattern: patternOf(segments, hasExt),
      ...(params.length ? {} : { pathname: route }),
      isIndex,
      prerender: false,
      fallbackRoutes: [],
      distURL: [],
      origin: "project",
      _meta: { trailingSlash: "ignore" },
    });
  }
  return sortRoutes(routes);
}

/** The route an integration injects (`injectRoute({ pattern, entrypoint })`). */
export function routeFromPattern(pattern: string, component: string): RouteData {
  const parts = pattern.split("/").filter(Boolean);
  const segments = parts.map(parseSegment);
  const params = segments
    .flat()
    .filter((p) => p.dynamic)
    .map((p) => p.content);
  const type = component.endsWith(".astro") ? "page" : "endpoint";
  const hasExt = type === "endpoint" && /\.[a-z0-9]+$/i.test(parts.at(-1) ?? "");
  const route = `/${parts.join("/")}`;
  return {
    route,
    component,
    type,
    params,
    segments,
    pattern: patternOf(segments, hasExt),
    ...(params.length ? {} : { pathname: route }),
    isIndex: false,
    prerender: false,
    fallbackRoutes: [],
    distURL: [],
    origin: "external",
    _meta: { trailingSlash: "ignore" },
  };
}

/** Astro's route priority: static before dynamic, rest parameters last, longer first. */
export function sortRoutes(routes: RouteData[]): RouteData[] {
  const weight = (r: RouteData) =>
    r.segments.flat().reduce((w, p) => w + (p.spread ? 100 : p.dynamic ? 10 : 0), 0);
  return routes.sort((a, b) => {
    const n = Math.min(a.segments.length, b.segments.length);
    for (let i = 0; i < n; i++) {
      const wa = a.segments[i].reduce((w, p) => w + (p.spread ? 100 : p.dynamic ? 10 : 0), 0);
      const wb = b.segments[i].reduce((w, p) => w + (p.spread ? 100 : p.dynamic ? 10 : 0), 0);
      if (wa !== wb) return wa - wb;
    }
    return b.segments.length - a.segments.length || weight(a) - weight(b);
  });
}
