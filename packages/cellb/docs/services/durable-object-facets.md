# Durable Object facets

A facet is a Durable Object whose class comes from code loaded at run time, attached to a parent
object: `this.ctx.facets.get(name, () => ({ class }))`. Each facet has its own SQLite database and
is stored alongside its parent, as celld stores it.

```jsonc
{
  "name": "facets",
  "main": "index.js",
  "compatibility_date": "2026-01-01",
  "worker_loaders": [{ "binding": "LOADER" }],
  "durable_objects": {
    "bindings": [{ "name": "SUPERVISOR", "class_name": "Supervisor" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Supervisor"] }]
}
```

```js
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// The code of the facet. A real application would load it from a bundle,
// a database, or a request; here it is a string so the example is one file.
const CODE = `
  import { DurableObject } from "cloudflare:workers";
  export class App extends DurableObject {
    async fetch() {
      const n = this.ctx.storage.kv.get("n") ?? 0;
      this.ctx.storage.kv.put("n", n + 1);
      const greeting = await this.env.GREETER.greet("facet");
      return new Response(String(n) + ":" + greeting);
    }
  }
`;

export class Greeter extends WorkerEntrypoint {
  greet(name) {
    return `${this.ctx.props.greeting}, ${name}`;
  }
}

export class Supervisor extends DurableObject {
  fetch(request) {
    const worker = this.env.LOADER.get("app-v1", () => ({
      compatibilityDate: "2025-01-01",
      mainModule: "app.js",
      modules: { "app.js": CODE },
      env: {
        GREETER: this.ctx.exports.Greeter({
          props: { greeting: "hello" },
        }),
      },
    }));
    const facet = this.ctx.facets.get("app", () => ({
      class: worker.getDurableObjectClass("App"),
    }));
    return facet.fetch(request);
  }
}

export default {
  fetch(request, env) {
    return env.SUPERVISOR.getByName("only").fetch(request);
  },
};
```

This is celld's `facets` example ([conformance/celld-examples/facets](../../conformance/celld-examples/facets/index.js)), copied
unchanged and run by the conformance suite on Node and in Chromium.

## A facet runs with its loaded Worker and is stored with its parent

- A facet of loaded code runs inside that loaded Worker's realm ([Dynamic Workers](dynamic-workers.md)),
  with its own SQLite.
- Its commits are logged through the parent's storage: a database and an LTX stream per facet, at
  `cells/<root>/facets/<SHA-256(name)[0..16] hex>/ltx/…`, under the root's epoch, as on celld.
- When the facet opens, under the root's lease, its database is rebuilt from that storage, as the
  root's is; its rows are rescoped to the current run.

## How it is checked

celld's `facets` example and CellB's `facets-api` project, on Node and in Chromium.
