// Official SDK bundler presets: dist/manifest.js and dist/worker.js are each one
// self-contained file, so Paperclip never mixes a new manifest with cached modules.
// dist/replay-cli.js is the replay tool (vt-replay run); it does not use the SDK.
import { build } from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ sourcemap: true });
await Promise.all([
  build(presets.esbuild.worker),
  build(presets.esbuild.manifest),
  build({ entryPoints: ["src/replay-main.ts"], outfile: "dist/replay-cli.js", bundle: true, platform: "node", format: "esm", target: "node24", sourcemap: false }),
]);
