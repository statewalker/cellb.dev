import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "e2e/**/*.test.ts"],
    // One S3 bucket per run (and a RustFS of its own unless RUSTFS_ENDPOINT is set).
    globalSetup: ["test/test-bucket.ts"],
  },
});
