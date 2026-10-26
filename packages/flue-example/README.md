# @statewalker/flue-example

A [Flue](https://flueframework.com/) agent app, built with Flue's own Cloudflare build and run on
cellb instead of Cloudflare. One agent, `Assistant`, has one tool; its model is a fake
OpenAI-compatible endpoint, so the whole thing runs offline once the packages are installed. The
package is private: it is a test of cellb, not a library.

## Why it exists

Flue builds each agent as a Durable Object on Cloudflare's Agents SDK. That is a large, real Worker
that cellb did not write: it reads `env` from `cloudflare:workers` while its module is evaluated,
imports `cloudflare:email` and bare Node.js built-in names, writes SQL with internal names in string
literals, and commits several times within one event. cellb's own tests check each of these alone
(`packages/cellb/test/p13-agents-sdk-host.test.ts`); this app checks them together, as a real
Agents SDK app uses them.

## How to use it

```
pnpm install            # at the repository root; needs network access
pnpm test               # in this directory: vite build, then vitest run
```

`vite build` runs `flue()` and `@cloudflare/vite-plugin` and emits `dist/flue_example/`: a Worker
module, one generated Durable Object class per agent, and a `wrangler.json`. The tests load that
output with `loadNodeProject` from `@statewalker/cellb/node` and talk to it with Flue's own client,
`@flue/sdk`.

## Examples

What `test/flue-on-cellb.test.ts` proves:

1. The app loads with nothing in `unsupported`. A prompt is admitted, runs from the agent's alarm,
   calls the tool, and the reply and the history read back from the agent's SQLite.
2. A reply is observed live over SSE while two conversations run at once.
3. A node stops in the middle of a model call. A second node on the same fleet bucket, with no local
   state, takes the cell over, and Flue's recovery finishes the submission there.

The core of it, against the build:

```ts
import { createFlueClient } from "@flue/sdk";
import { loadNodeProject, nodeSqliteOpener } from "@statewalker/cellb/node";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

const { runtime } = await loadNodeProject(dir, { openSql: nodeSqliteOpener(), files: new MemFilesApi() });
const client = createFlueClient({
  url: "http://app.test/agents/assistant/conv-1",
  fetch: (input, init) => runtime.fetch(new Request(input, init)),
});
const reply = await client.read(await client.send({ message: { kind: "user", body: "What is the answer?" } }));
```

## Internals

### Everything runs in the test process

The fake model (`test/fake-llm.ts`) listens on a port the OS picks; the fleet bucket is a
`memoryObjectStore()` per test; each test copies the build to a temporary directory and points its
`LLM_BASE_URL` var at the fake. Nothing is shared between runs, so parallel runs in other worktrees
do not collide, and nothing needs celld or RustFS.

### Decisions a reader would otherwise undo

- **No built-in Flue providers** (`flue({ providers: [] })`). Flue's `cloudflare` provider adds a
  Workers AI binding, which cellb reports in `unsupported`; the app registers its own
  OpenAI-compatible provider instead (`src/app.ts`).
- **The model URL comes from `env`, read at module evaluation.** That is how Flue apps configure
  providers, and it is the path cellb's per-project `cloudflare:workers` `env` exists for.
- **`vite.config.ts` is for the build only; `vitest.config.ts` is separate.** With the Cloudflare
  plugin loaded, vitest tries to run the tests in workerd.
- **`src/cloudflare-workers.d.ts` types only `env`.** It is the one part of `cloudflare:workers` the
  app reads; pulling in `@cloudflare/workers-types` would clash with the DOM types the tests use.

### What will surprise you

- **`No API key for provider: local`.** pi-ai's OpenAI client refuses an empty key even for a
  keyless endpoint; the provider resolves a placeholder.
- **`observe()` reports `absent`** when it is called before the conversation exists: send first.
- **`run vite build first (pnpm test does)`** is what `vitest run` alone says without `dist/`.
- What cellb still lacks for Agents SDK apps (browser `env`/`exports`, `AsyncLocalStorage` in
  browsers, partyserver's WebSocket attachments) is in `../cellb/docs/gaps.md`.

### Dependencies

`@flue/runtime`, `@flue/vite`, `@flue/sdk` (pinned together: the build and the client must agree),
`@earendil-works/pi-ai` (Flue's model layer), `hono` (the app's router), `@cloudflare/vite-plugin`
and `wrangler` (Flue's Cloudflare build), `@statewalker/cellb` (the runtime under test).

## License

MIT
