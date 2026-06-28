// @ts-check
import { defineConfig } from "astro/config";

// Project Pages URL: https://jrepp.github.io/merge-god/
export default defineConfig({
  site: "https://jrepp.github.io",
  base: "/merge-god",
  trailingSlash: "ignore",
  prefetch: true,
  build: {
    format: "directory",
  },
});
