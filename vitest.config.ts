import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      "@utils": new URL("./src/utils", import.meta.url).pathname,
    },
  },
});
