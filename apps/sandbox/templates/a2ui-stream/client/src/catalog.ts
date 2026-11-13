// The catalog: the only components this client renders. An agent composes screens from these;
// anything else is refused by the server and drawn as an error here.

export interface Component {
  id: string;
  component: string;
  [prop: string]: unknown;
}
/** A literal, or a binding to the surface's data model: { path: "/clicks" }. */
export type Value = unknown;
export interface Ctx {
  /** A literal as is, a binding read from the data model. */
  value(v: Value): unknown;
  /** Writes the data model locally (a TextField's input). */
  set(path: string, value: unknown): void;
  /** Sends an action: { name, context } with the context's bindings resolved. */
  act(action: { name: string; context?: Record<string, Value> }): void;
  child(id: string): HTMLElement;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};
const kids = (parent: HTMLElement, c: Component, ctx: Ctx) => {
  for (const id of (c.children as string[] | undefined) ?? []) parent.append(ctx.child(id));
  return parent;
};

export const catalog: Record<string, (c: Component, ctx: Ctx) => HTMLElement> = {
  Column: (c, ctx) => kids(el("div", "stack"), c, ctx),
  Row: (c, ctx) => kids(el("div", "stack row"), c, ctx),
  Card: (c, ctx) => {
    const card = el("section", "card");
    if (c.title) card.append(el("h2", undefined, String(ctx.value(c.title))));
    return kids(card, c, ctx);
  },
  Heading: (c, ctx) => el("h1", undefined, String(ctx.value(c.text) ?? "")),
  Text: (c, ctx) => el("p", undefined, String(ctx.value(c.text) ?? "")),
  Badge: (c, ctx) =>
    el("span", `badge ${String(c.tone ?? "neutral")}`, String(ctx.value(c.text) ?? "")),
  Button: (c, ctx) => {
    const b = el("button", undefined, String(ctx.value(c.label) ?? "OK"));
    b.type = "button";
    b.onclick = () => ctx.act(c.action as { name: string; context?: Record<string, Value> });
    return b;
  },
  TextField: (c, ctx) => {
    const input = el("input");
    input.placeholder = String(c.label ?? "");
    input.setAttribute("aria-label", String(c.label ?? c.id));
    const bound = c.value as { path?: string } | undefined;
    input.value = String(ctx.value(c.value) ?? "");
    input.oninput = () => bound?.path && ctx.set(bound.path, input.value);
    return input;
  },
  List: (c, ctx) => {
    const ul = el("ul");
    const items = ctx.value(c.items);
    for (const item of Array.isArray(items) ? items : [])
      ul.append(el("li", undefined, String(item)));
    return ul;
  },
};
