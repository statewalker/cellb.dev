// The catalog: the only components a spec can name. A spec that names anything else is shown as
// an error, never run — the catalog is the boundary between what an agent writes and the page.

export interface Element {
  type: string;
  props?: Record<string, unknown>;
  children?: string[];
}

export interface RenderContext {
  state: Record<string, unknown>;
  fields: Record<string, string>;
  act(action: string, params: Record<string, unknown>): void;
}

type Component = (el: Element, children: HTMLElement[], ctx: RenderContext) => HTMLElement;

const h = (tag: string, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export function lookup(state: Record<string, unknown>, path: string): unknown {
  let v: unknown = state;
  for (const p of path.split("/").filter(Boolean)) v = (v as Record<string, unknown>)?.[p];
  return v;
}

const str = (v: unknown) =>
  v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);

export const catalog: Record<string, Component> = {
  Stack(el, children) {
    const e = h("div", `stack ${el.props?.direction === "row" ? "row" : "column"}`);
    e.style.gap = `${Number(el.props?.gap ?? 8)}px`;
    e.append(...children);
    return e;
  },
  Card(el, children) {
    const e = h("section", "card");
    if (el.props?.title) e.append(h("h2", "card-title", str(el.props.title)));
    e.append(...children);
    return e;
  },
  Heading: (el) => h("h1", "heading", str(el.props?.text)),
  Text: (el, _c, ctx) =>
    h(
      "p",
      "text",
      el.props?.bind ? str(lookup(ctx.state, String(el.props.bind))) : str(el.props?.text),
    ),
  Badge: (el) => h("span", `badge ${str(el.props?.tone) || "neutral"}`, str(el.props?.text)),
  Button(el, _c, ctx) {
    const e = h("button", "button", str(el.props?.label)) as HTMLButtonElement;
    e.type = "button";
    e.onclick = () =>
      ctx.act(str(el.props?.action), {
        ...((el.props?.params as Record<string, unknown>) ?? {}),
        fields: { ...ctx.fields },
      });
    return e;
  },
  TextField(el, _c, ctx) {
    const name = str(el.props?.name);
    const e = h("input", "field") as HTMLInputElement;
    e.placeholder = str(el.props?.placeholder);
    e.setAttribute("aria-label", e.placeholder || name);
    e.value = ctx.fields[name] ?? "";
    e.oninput = () => {
      ctx.fields[name] = e.value;
    };
    return e;
  },
  List(el, _c, ctx) {
    const e = h("ul", "list");
    const items = lookup(ctx.state, str(el.props?.bind));
    for (const item of Array.isArray(items) ? items : []) e.append(h("li", "", str(item)));
    return e;
  },
};
