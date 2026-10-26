# flue-example

A [Flue](https://flueframework.com/) agent app built for Flue's Cloudflare target and run on
cellb instead of Cloudflare. The build is Flue's own: `vite build` with `flue()` and
`@cloudflare/vite-plugin` emits `dist/flue_example/` (a Worker module, one generated Durable
Object class per agent on the Agents SDK, and a `wrangler.json`). The tests load that output with
`loadNodeProject` and talk to it with Flue's own client, `@flue/sdk`.

The model is a fake OpenAI-compatible endpoint (`test/fake-llm.ts`) that answers with a scripted
tool call and then a text reply, so a test exercises two model turns and one tool call. The app
reads the endpoint's URL from `env.LLM_BASE_URL` while its module is evaluated (`src/app.ts`).

## How to run it

`pnpm test`: builds, then runs `test/flue-on-cellb.test.ts`:

1. The app loads with nothing in `unsupported`; a prompt is admitted, run from the agent's alarm,
   calls the tool, and the reply and history read back from the agent's SQLite.
2. A reply is observed live over SSE while two conversations run at once.
3. A node stops in the middle of a model call; a second node on the same fleet bucket, with no
   local state, takes the cell over, and Flue's recovery finishes the submission there.

## What will surprise you

- `vite.config.ts` is for the build only; `vitest.config.ts` keeps the Cloudflare plugin out of
  the test run (with it, vitest tries to run the tests in workerd).
- The provider needs some API key even for a keyless endpoint: pi-ai's OpenAI client refuses an
  empty one (`No API key for provider: local`).
- A conversation must exist before `observe()` follows it live; observing first reports `absent`.
- What cellb still lacks for Agents SDK apps is in `../cellb/docs/gaps.md`.
