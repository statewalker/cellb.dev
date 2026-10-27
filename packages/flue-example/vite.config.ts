import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import { defineConfig } from "vite";

// Flue's own Cloudflare build: flue() generates the Worker entry (one Durable Object class
// per agent) and cloudflare() bundles it. Two providers: the app's own OpenAI-compatible
// endpoint (`local`, src/app.ts) and Flue's `cloudflare`, which calls the Workers AI binding
// (`env.AI`, wrangler.jsonc); cellb serves that binding from an OpenAI-compatible endpoint too.
export default defineConfig({
  plugins: [flue({ providers: ["cloudflare"] }), cloudflare({ config: flueWorkerConfig() })],
});
