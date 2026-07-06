import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/plugin.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    external: [
      "child_process",
      "fs",
      "path",
      "url",
      "https",
    ],
  },
]);
