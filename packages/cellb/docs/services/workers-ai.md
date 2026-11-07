# Workers AI

The `ai` binding (`env.AI.run(model, input)`) answers through an OpenAI-compatible endpoint the host
names, such as a local llama.cpp or Ollama server, a hosted API, or a test's fake model. celld has
no such binding. CellB has one so that agent frameworks written for Workers AI, such as Flue, run
unchanged.

```jsonc
{ "name": "p14", "main": "index.js", "ai": { "binding": "AI" } }
```

The host names the endpoint and maps Workers AI model ids to the endpoint's models. `"*"` covers
every id that is not listed:

```ts
const p = await loadNodeProject(dir, {
  openSql: nodeSqliteOpener(),
  files: new MemFilesApi(),
  ai: {
    baseUrl: llm.baseUrl, // up to /v1, e.g. http://127.0.0.1:8080/v1
    apiKey: "k", // sent as Authorization: Bearer …
    models: { "@cf/meta/llama-3.1-8b-instruct": "llama", "*": "fallback" },
  },
});
```

`browserProjectRuntime` and `startProjectShards` take the same `ai` option. The project and host
above come from `test/p14-workers-ai.test.ts`, which runs them against a fake OpenAI-compatible
model.

## What `env.AI.run()` answers

| Input | Answer |
|---|---|
| `{ prompt }` or `{ messages, tools? }` | `{ response, tool_calls?, usage }`, Workers AI's shape |
| the same with `stream: true` | a stream of `data: {"response": …}` lines, ending `data: [DONE]`; tool calls arrive whole, once |
| any of these, with `{ returnRawResponse: true }` as the third argument | the endpoint's own `Response`, which is what Flue's provider reads |
| `{ text: [...] }` (embeddings) | `{ shape, data, pooling }` |

## How it is checked

`test/p14-workers-ai.test.ts` in Node, and Flue's `cloud` agent in Node and in Chromium
([Flue agent app](../../../../examples/flue/README.md)).

## What breaks

- **Without an endpoint, the binding is not supported** and is listed in `unsupported`.
- **Image, speech and classification models throw.** Only text generation and embeddings are served.
- **The `gateway` option of `run()` (AI Gateway) is accepted and ignored**, and `env.AI.gateway()`
  throws.
