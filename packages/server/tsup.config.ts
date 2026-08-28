import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: "esm",
  target: "node18",
  platform: "node",
  clean: true,
  sourcemap: false,
  dts: false,
  splitting: false,
});
