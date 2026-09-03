import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

export default mergeConfig(baseConfig, defineConfig({
  test: {
    // Keep the deterministic gate isolated at the file level. Several legacy
    // suites intentionally replace process globals or DATA_DIR and are not
    // safe to execute concurrently with unrelated files.
    fileParallelism: false,
    setupFiles: ["tests/vitest.offline.setup.js"],
    exclude: [
      ...(baseConfig.test?.exclude || []),
      "**/*.live.test.js",
      "**/*.real.test.js",
      "**/tests/translator/real/**",
      // Cloudflare Worker-only fixtures and the optional lowdb benchmark are
      // kept out of the local Node gate; they have separate runtime/dependency
      // requirements and are not part of the deterministic gateway contract.
      "**/*.cloud.test.js",
      "**/db-benchmark.test.js",
    ],
  },
}));
