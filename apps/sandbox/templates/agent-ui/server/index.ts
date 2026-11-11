import { DurableObject } from "cloudflare:workers";

// A spec: a flat tree of elements (json-render / A2UI style) and the state its bindings read.
export interface Spec {
  root: string;
  elements: Record<string, { type: string; props?: Record<string, unknown>; children?: string[] }>;
  state?: Record<string, unknown>;
}

const INITIAL: Spec = {
  root: "main",
  elements: {
    main: { type: "Stack", props: { gap: 12 }, children: ["title", "intro", "counter", "notes"] },
    title: { type: "Heading", props: { text: "A screen an agent pilots" } },
    intro: {
      type: "Text",
      props: {
        text: "This UI is data in a Durable Object. An agent changes it with PUT api/surfaces/main; your clicks come back as actions.",
      },
    },
    counter: { type: "Card", props: { title: "Counter" }, children: ["count-row"] },
    "count-row": {
      type: "Stack",
      props: { direction: "row", gap: 8 },
      children: ["count", "plus"],
    },
    count: { type: "Text", props: { bind: "/count" } },
    plus: {
      type: "Button",
      props: { label: "+1", action: "increment", params: { path: "/count" } },
    },
    notes: { type: "Card", props: { title: "Notes" }, children: ["note-row", "note-list"] },
    "note-row": { type: "Stack", props: { direction: "row", gap: 8 }, children: ["note", "add"] },
    note: { type: "TextField", props: { name: "note", placeholder: "Write a note" } },
    add: {
      type: "Button",
      props: { label: "Add", action: "push", params: { path: "/notes", field: "note" } },
    },
    "note-list": { type: "List", props: { bind: "/notes" } },
  },
  state: { count: 0, notes: [], actions: [] },
};

type Json = Record<string, unknown>;

function at(state: Json, path: string): { parent: Json; key: string } {
  const parts = path.split("/").filter(Boolean);
  if (!parts.length) throw new Error("a path names a key, e.g. /count");
  let parent = state;
  for (const p of parts.slice(0, -1)) {
    if (typeof parent[p] !== "object" || parent[p] === null) parent[p] = {};
    parent = parent[p] as Json;
  }
  return { parent, key: parts[parts.length - 1] };
}

export class Surface extends DurableObject {
  async read(): Promise<{ spec: Spec; version: number }> {
    const spec = (await this.ctx.storage.get<Spec>("spec")) ?? INITIAL;
    const version = (await this.ctx.storage.get<number>("version")) ?? 0;
    return { spec, version };
  }

  async replace(spec: Spec) {
    if (!spec || typeof spec.root !== "string" || typeof spec.elements !== "object")
      throw new Error("a spec has a root and elements");
    const { version } = await this.read();
    await this.ctx.storage.put({ spec, version: version + 1 });
    return this.read();
  }

  async act(action: string, params: Json = {}) {
    const { spec } = await this.read();
    spec.state ??= {};
    const state = spec.state;
    const fields = (params.fields ?? {}) as Json;
    if (action === "set") {
      const { parent, key } = at(state, String(params.path));
      parent[key] = params.value;
    } else if (action === "increment") {
      const { parent, key } = at(state, String(params.path));
      parent[key] = Number(parent[key] ?? 0) + 1;
    } else if (action === "push") {
      const value = params.field ? fields[String(params.field)] : params.value;
      if (value !== undefined && value !== "") {
        const { parent, key } = at(state, String(params.path));
        parent[key] = [...((parent[key] as unknown[]) ?? []), value];
      }
    } else {
      const log = ((state.actions as unknown[]) ?? []).slice(-49);
      state.actions = [...log, { action, params, at: new Date().toISOString() }];
    }
    return this.replace(spec);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: { SURFACES: DurableObjectNamespace<Surface> }) {
    const url = new URL(request.url);
    const m = /^\/api\/surfaces\/([\w-]+)(\/actions)?$/.exec(url.pathname);
    if (!m) return json({ error: "not found" }, 404);
    const surface = env.SURFACES.get(env.SURFACES.idFromName(m[1]));
    try {
      if (m[2] && request.method === "POST") {
        const { action, params } = (await request.json()) as { action: string; params?: Json };
        return json(await surface.act(action, params));
      }
      if (request.method === "PUT") {
        const out = await surface.replace(await request.json());
        console.log(`surface ${m[1]} replaced (version ${out.version})`);
        return json(out);
      }
      if (request.method === "GET") return json(await surface.read());
      return json({ error: "method not allowed" }, 405);
    } catch (err) {
      return json({ error: (err as Error).message }, 400);
    }
  },
};
