import { defineConfig } from "vitest/config";

// Tests run in Node against the built app; vite.config.ts is for `vite build` only.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
