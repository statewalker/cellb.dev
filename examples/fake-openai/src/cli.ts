#!/usr/bin/env node
// Runs the fake model on its own, for `celld dev` or a manual try:
//   node examples/fake-openai/src/cli.ts [port]
// It answers with the default script (see `defaultReply`) and logs each request.
import { defaultReply, lastUserText, startFakeOpenAi } from "./index.ts";

const port = Number(process.argv[2] ?? process.env.PORT ?? 8787);
const fake = await startFakeOpenAi({
  port,
  reply: (req) => {
    const turn = defaultReply(req);
    console.log(`${req.model}: "${lastUserText(req)}" → ${JSON.stringify(turn)}`);
    return turn;
  },
});
console.log(`fake OpenAI endpoint at ${fake.baseUrl} (chat: ${fake.chatUrl})`);
