// Bundles the TypeScript server into a single ESM file. Runtime npm
// dependencies stay external and are loaded from node_modules.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["server/index.ts"],
  outfile: "build/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: [...Object.keys(pkg.dependencies ?? {}), "node:*"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
console.log("server bundle written to build/server.mjs");
