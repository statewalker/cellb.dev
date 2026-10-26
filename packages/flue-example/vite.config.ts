import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import { defineConfig } from "vite";

// Flue's own Cloudflare build: flue() generates the Worker entry (one Durable Object class
// per agent) and cloudflare() bundles it. No built-in providers: the only model is the
// app's own OpenAI-compatible endpoint (src/app.ts), so no Workers AI binding either.
export default defineConfig({
  plugins: [flue({ providers: [] }), cloudflare({ config: flueWorkerConfig() })],
});
