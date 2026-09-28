/**
 * Bundles the proxy (src/*.ts) into dist/server.mjs for the packaged app, which runs it inside Electron
 * (utilityProcess), so people do not need Node.js or tsx installed.
 *
 *   npm run build:proxy
 *
 * npm packages stay external: they ship in the app's node_modules. The Copilot SDK in particular must stay
 * there, because it finds its platform runtime (@github/copilot-sdk-<platform>) relative to its own files.
 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const dist = new URL("dist/", root);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const result = await build({
  entryPoints: [new URL("src/server.ts", root).pathname],
  outfile: new URL("server.mjs", dist).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  legalComments: "inline",
  logLevel: "warning",
  metafile: true,
});

// news.ts reads the catalog next to itself (new URL("./catalog.json", import.meta.url)).
copyFileSync(new URL("src/catalog.json", root), new URL("catalog.json", dist));

const bytes = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
console.log(`dist/server.mjs ${(bytes / 1024).toFixed(0)} KB (+ dist/catalog.json)`);
