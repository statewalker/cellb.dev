# @statewalker/fake-openai

A scripted OpenAI-compatible model endpoint for running agents offline: `POST /v1/chat/completions`
(streamed or not, text or tool calls), `POST /v1/embeddings` and `GET /v1/models`. The package is
private: the agent examples and the Flue example test against it.

## Why it exists

Agent frameworks (pi, opencode, Flue, the Workers AI binding) need a model to do anything, and a
real one makes a test slow, paid, non-deterministic and dependent on the network. This endpoint
speaks the OpenAI wire format closely enough for their OpenAI clients (streamed deltas a word at a
time, tool calls streamed as OpenAI streams them, a usage chunk, `[DONE]`), answers from a script,
and records every request, so a test can assert what the agent sent.

## How to use it

```ts
import { lastUserText, startFakeOpenAi, toolResults } from "@statewalker/fake-openai";

const fake = await startFakeOpenAi(); // the default script, on a port the OS picks
// point the agent at fake.baseUrl ("http://127.0.0.1:<port>/v1")
// … run it …
fake.requests;      // every chat request, parsed
fake.authorizations; // their Authorization headers
await fake.close();
```

From a shell, for `celld dev` or a manual try (Node 22.18 or later runs the TypeScript directly):

```sh
node packages/fake-openai/src/cli.ts 8787   # http://127.0.0.1:8787/v1
```

## Examples

### The default script

`defaultReply` answers: with tools offered and none answered yet, a call of the first tool (no
arguments); once a tool answered, `The tool said: <its result>`; otherwise
`fake-model heard: <the last user message>`. An agent with one tool therefore makes two model calls
and ends with the tool's result as its reply.

### A script of your own

```ts
const fake = await startFakeOpenAi({
  reply: (req) =>
    toolResults(req).length
      ? { text: "done" }
      : { tools: [{ name: "search", args: { q: lastUserText(req) } }] },
  delayMs: 50, // concurrent conversations overlap
});
```

A turn is `{ text }`, `{ tool, args }` or `{ tools: [{ name, args }] }`. `holdNext()` keeps the next
response open until its `release()`, to test what happens while a model call is in flight.

## Internals

- **CORS is open**, so a page or worker on another origin (a browser test) can call it.
- **Embeddings** are deterministic 8-dimensional unit vectors of the text.
- **Only Chat Completions**: the Responses API and image or audio models are not served.

## License

MIT
