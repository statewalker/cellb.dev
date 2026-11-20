import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Containers download and compile WASIX packages (cached in .wasmer/ after the first run).
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One Wasmer client per file; files in parallel would multiply worker pools.
    fileParallelism: false,
  },
});
