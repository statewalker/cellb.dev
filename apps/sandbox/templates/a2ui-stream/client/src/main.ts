import { type Component, type Ctx, catalog } from "./catalog";

// The client side of the stream: it follows the message log (GET api/stream?since=…), applies each
// message to its surfaces in order, and draws them. Actions go back with POST api/actions.

interface Surface {
  title?: string;
  components: Map<string, Component>;
  data: Record<string, unknown>;
}

const STREAM = new URLSearchParams(location.search).get("stream") ?? "main";
const q = `stream=${encodeURIComponent(STREAM)}`;
const root = document.getElementById("root") as HTMLElement;
const surfaces = new Map<string, Surface>();
let last = 0;

function pointer(data: Record<string, unknown>, path: string, value?: unknown, write = false) {
  const parts = path.split("/").filter(Boolean);
  let at: Record<string, unknown> = data;
  for (const p of parts.slice(0, -1)) {
    if (typeof at[p] !== "object" || at[p] === null) {
      if (!write) return undefined;
      at[p] = {};
    }
    at = at[p] as Record<string, unknown>;
  }
  const key = parts.at(-1);
  if (key === undefined) return write ? undefined : data;
  if (write) at[key] = value;
  return at[key];
}

function apply(message: Record<string, Record<string, unknown>>) {
  const [kind] = Object.keys(message);
  const body = message[kind] as { surfaceId: string } & Record<string, unknown>;
  const s = surfaces.get(body.surfaceId);
  if (kind === "createSurface")
    surfaces.set(body.surfaceId, { title: body.title as string, components: new Map(), data: {} });
  else if (kind === "deleteSurface") surfaces.delete(body.surfaceId);
  else if (!s) console.warn(`${kind} for a surface not created: ${body.surfaceId}`);
  else if (kind === "updateComponents")
    for (const c of body.components as Component[]) s.components.set(c.id, c);
  else if (kind === "updateDataModel") pointer(s.data, body.path as string, body.value, true);
}

function draw() {
  root.replaceChildren();
  for (const [id, s] of surfaces) {
    const seen = new Set<string>();
    const ctx: Ctx = {
      value: (v) =>
        v && typeof v === "object" && "path" in (v as object)
          ? pointer(s.data, (v as { path: string }).path)
          : v,
      set: (path, value) => pointer(s.data, path, value, true),
      act: (action) => void send(id, action, ctx),
      child: (cid) => {
        const c = s.components.get(cid);
        const error = (text: string) =>
          Object.assign(document.createElement("p"), { className: "error", textContent: text });
        if (!c) return error(`missing component: ${cid}`);
        if (seen.has(cid)) return error(`a cycle at ${cid}`);
        seen.add(cid);
        const make = catalog[c.component];
        return make ? make(c, ctx) : error(`not in the catalog: ${c.component}`);
      },
    };
    const section = document.createElement("div");
    section.dataset.surface = id;
    section.append(s.components.has("root") ? ctx.child("root") : document.createTextNode(""));
    root.append(section);
  }
}

async function send(
  surfaceId: string,
  action: { name: string; context?: Record<string, unknown> },
  ctx: Ctx,
) {
  const context: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(action.context ?? {})) context[k] = ctx.value(v);
  await fetch(`api/actions?${q}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ surfaceId, name: action.name, context }),
  });
}

async function follow() {
  for (;;) {
    try {
      const res = await fetch(`api/stream?${q}&since=${last}`);
      const { messages } = (await res.json()) as {
        messages: { seq: number; message: Record<string, Record<string, unknown>> }[];
      };
      // A text field being typed in is not redrawn under the person's fingers: drawing waits.
      if (messages.length) {
        for (const m of messages) {
          apply(m.message);
          last = m.seq;
        }
        if (!(document.activeElement instanceof HTMLInputElement)) draw();
        else document.activeElement.addEventListener("blur", draw, { once: true });
      }
    } catch (err) {
      console.error(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

void follow();
