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
pnpm test               # in this directory: vite build, then vitest run (Node)
pnpm test:browser       # vite build, then Playwright in Chromium
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

What `test/browser/flue-in-browser.spec.ts` proves, with the same build run in Chromium:
`bundleWorkerForBrowser` (from `@statewalker/cellb/node`) turns `dist/flue_example/` into one ES
module, and a Dedicated Worker (`browser/flue-worker.ts`) hosts it with `browserProjectRuntime`
(SQLite WASM on OPFS) and drives it with `@flue/sdk`, inside the browser:

1. A prompt runs through the tool call to the reply, and the history reads back.
2. A reply is observed live over SSE.
3. Two conversations run at once (their model calls interleave), and each one's stored history
   holds its own question and answer only.
4. A second runtime on the same OPFS pool (a page reload) reads the first conversation back.
5. Nothing is logged as a warning or an error on the way.
6. With 8 and with 32 conversations at once, each conversation's `whoami` tool reads its own
   conversation from Flue's context (`getDurableObjectIdentity()`, an `AsyncLocalStorage`), before
   and after an `await`; the Node suite checks the same with the real `node:async_hooks`.
7. Four messages sent to one conversation at once all settle, none is lost.

8. 32 conversations run over 1 and over 4 workers with cellb's `startProjectShards`
   (`browser/flue-shard-worker.ts` is the worker): each worker hosts the app with its own OPFS
   pool and owns its share of the conversations, and requests enter through every worker.

Concurrent conversations in one browser runtime take turns: it is one thread, and each Flue turn
makes 21 SQLite commits on OPFS there. Spreading them over workers runs them in parallel (see
`../cellb/docs/gaps.md` for the numbers).

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

### Everything runs on this machine

The fake model (`test/fake-llm.ts`) listens on a port the OS picks; the fleet bucket is a
`memoryObjectStore()` per test; each test copies the build to a temporary directory and points its
`LLM_BASE_URL` var at the fake. Nothing is shared between runs, so parallel runs in other worktrees
do not collide, and nothing needs celld or RustFS. The browser test uses the same fake (it answers
CORS preflights, since the worker's origin is the Vite server's) and a fresh OPFS pool per run.

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
- **The browser test's Chromium** is `PW_CHROMIUM`, else Playwright's own, else the one
  `@sparticuz/chromium` unpacks (as in `packages/cellb`).
- What cellb still lacks for Agents SDK apps (`AsyncLocalStorage` isolation in browsers,
  partyserver's WebSocket attachments, `env` on an in-browser site) is in `../cellb/docs/gaps.md`.

### Dependencies

`@flue/runtime`, `@flue/vite`, `@flue/sdk` (pinned together: the build and the client must agree),
`@earendil-works/pi-ai` (Flue's model layer), `hono` (the app's router), `@cloudflare/vite-plugin`
and `wrangler` (Flue's Cloudflare build), `@statewalker/cellb` (the runtime under test),
`@playwright/test`, `@sparticuz/chromium` and `@sqlite.org/sqlite-wasm` (the browser test).

## License

MIT
