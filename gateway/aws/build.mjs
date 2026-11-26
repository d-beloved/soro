// Bundles the Lambda handlers (src/lambda.ts) into aws/build/index.mjs, the code aws/template.yaml deploys.
import { build } from "esbuild";

await build({
  entryPoints: [new URL("../src/lambda.ts", import.meta.url).pathname],
  outfile: new URL("./build/index.mjs", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  // Some dependencies are CommonJS and call require(); give the ES module one.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
});
