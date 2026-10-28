# @statewalker/agent-examples

Coding-agent frameworks running in Durable Objects on cellb, each against a fake OpenAI-compatible
model (`@statewalker/fake-openai`), so the whole thing runs offline once the packages are installed:

| Example | Framework | What it shows |
|---|---|---|
| `pi/` | [pi](https://pi.dev)'s agent loop (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`) | a prompt runs a tool call and its follow-up; the transcript persists in the object's storage |
| `opencode/` | opencode's workerd SDK (`@opencode-ai/sdk/workerd`) | celld's opencode example: the SDK boots on the object's SQLite, creates a session, and the model answers a prompt |
| `../flue-example` | Flue (`@flue/runtime`) | a whole Flue app, built for Cloudflare, on Node and in browsers |

The package is private: it is a test of cellb, not a library.

## Why it exists

celld ships `pi` and `opencode` examples, but they need the network: `pi` depends on an unreleased
preview build of the `agents` package and OpenRouter, `opencode` on a free model from opencode's own
registry. These versions take the model from an endpoint named in the project's vars, which the
tests point at the fake model, and they run on cellb as celld runs them.

## How to use it

```
pnpm install            # at the repository root
pnpm test               # in this directory: each example on cellb (Node), against the fake model
```

To run one against a real endpoint, set its vars (`PI_BASE_URL`, `PI_MODEL`, `PI_API_KEY`;
`OPENCODE_BASE_URL`, `OPENCODE_MODEL`, `OPENCODE_API_KEY`) in `wrangler.jsonc` or `.dev.vars`, and
start it with `celld dev pi` or load it with `loadNodeProject`. Against the fake model:

```sh
node ../fake-openai/src/cli.ts 8787     # the vars' defaults point here
```

## Examples

What the tests prove:

1. **pi**: `GET /?q=…` runs the agent: the model is offered the `where_am_i` tool and calls it, the
   tool answers, and the second model call carries the result, which becomes the reply
   (`The tool said: a Durable Object on cellb`). A second prompt continues the same transcript,
   restored from storage.
2. **opencode**: `GET /` runs celld's probe (`model.default`, `provider.list`, `health.get`,
   `session.create`, `session.get`, `session.prompt`, `session.wait`, `message.list`); every step
   succeeds and the reply is the fake model's answer to `hello world`, from provider `endpoint`,
   model `fake-model`.

## Internals

### Differences from celld's examples

- **pi** uses pi's published packages instead of the `PiHarness` of `agents` pull request 2197
  (only on pkg.pr.new, which may expire, and unreachable from some networks). The object holds a
  pi `Agent` with one tool; the transcript is stored under the `messages` key.
- **opencode** adds `config` to `OpenCodeWorkerd.create()`: a provider `endpoint`
  (`@ai-sdk/openai-compatible` with `baseURL` from `OPENCODE_BASE_URL`) and `model:
  "endpoint/<OPENCODE_MODEL>"`. Everything else is celld's code.

### What surprised us

- **The opencode SDK builds a Response from another** (`new Response(body, response)`). cellb's
  `Response` lost the headers of such an init, so the SDK's client saw no `content-type` and failed
  with `ClientError: UnsupportedContentType`; it now reads the init as Fetch does.
- **Packages with only a `main` field did not resolve** in cellb's Node bundles (esbuild's neutral
  platform has no main fields): opencode's dependencies (`@smithy/*`) failed to build. Node bundles
  now resolve as `celld deploy` does: conditions `workerd`, `worker`, `browser`, then `module` and
  `main`.
- **The opencode bundle is large** (about 430,000 lines): its first load takes about half a minute.

### Dependencies

`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` (pi), `@opencode-ai/sdk` (pinned to the
build celld's example uses); `@statewalker/cellb`, `@statewalker/fake-openai` and vitest for the
tests.

## License

MIT; `opencode/index.js` is adapted from celld's example (Apache-2.0).
