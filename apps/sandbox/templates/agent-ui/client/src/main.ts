import { catalog, type Element, type RenderContext } from "./catalog";

interface Spec {
  root: string;
  elements: Record<string, Element>;
  state?: Record<string, unknown>;
}

const SURFACE = new URLSearchParams(location.search).get("surface") ?? "main";
const api = `api/surfaces/${SURFACE}`;
const root = document.getElementById("root") as HTMLElement;
const fields: Record<string, string> = {};
let version = -1;

function render(spec: Spec) {
  const ctx: RenderContext = { state: spec.state ?? {}, fields, act };
  const seen = new Set<string>();
  const build = (id: string): HTMLElement => {
    const el = spec.elements[id];
    if (!el || seen.has(id))
      return Object.assign(document.createElement("p"), {
        className: "error",
        textContent: `missing element: ${id}`,
      });
    seen.add(id);
    const component = catalog[el.type];
    if (!component)
      return Object.assign(document.createElement("p"), {
        className: "error",
        textContent: `not in the catalog: ${el.type}`,
      });
    return component(el, (el.children ?? []).map(build), ctx);
  };
  root.replaceChildren(build(spec.root));
}

async function act(action: string, params: Record<string, unknown>) {
  const res = await fetch(`${api}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, params }),
  });
  const data = (await res.json()) as { spec: Spec; version: number };
  const field = params.field as string | undefined;
  if (field) fields[field] = "";
  version = data.version;
  render(data.spec);
}

async function poll() {
  try {
    const data = (await (await fetch(api)).json()) as { spec: Spec; version: number };
    // Re-render only when the spec changed, so typing in a field is not interrupted.
    if (data.version !== version) {
      version = data.version;
      render(data.spec);
    }
  } catch (err) {
    root.textContent = `the server did not answer: ${(err as Error).message}`;
  }
}

await poll();
setInterval(poll, 1000);
