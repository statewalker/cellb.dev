// getDurableObjectClass(name, { props }): a facet of a loaded class reads them as ctx.props,
// plain values and a stub alike.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const LOADED = `
import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async probe() {
    const { greeter, ...plain } = this.ctx.props ?? {};
    return { plain, greeting: greeter ? await greeter.greet() : null };
  }
}
`;

export class Greeter extends WorkerEntrypoint {
  greet() {
    return `hi, ${this.ctx.props.name}`;
  }
}

export class Holder extends DurableObject {
  async probe() {
    const worker = this.env.LOADER.get("w", () => ({
      compatibilityDate: "2026-01-01",
      mainModule: "w.js",
      modules: { "w.js": LOADED },
    }));
    const withProps = worker.getDurableObjectClass("Counter", {
      props: { foo: 123, bar: [4, 5], greeter: this.ctx.exports.Greeter({ props: { name: "Ann" } }) },
    });
    const without = worker.getDurableObjectClass("Counter");
    return {
      withProps: await this.ctx.facets.get("a", () => ({ class: withProps })).probe(),
      without: await this.ctx.facets.get("b", () => ({ class: without })).probe(),
    };
  }
}

export default {
  async fetch(request, env) {
    return Response.json(await env.HOLDER.getByName("h").probe());
  },
};
