import { defineConfig } from "vitest/config";

// Tests run in Node against the built app (`astro build` writes dist/).
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 120_000 } });
