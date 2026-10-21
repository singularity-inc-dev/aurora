// Official SDK bundler presets: dist/manifest.js and dist/worker.js are each one
// self-contained file, so Paperclip never mixes a new manifest with cached modules.
import { build } from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ sourcemap: true });
await Promise.all([build(presets.esbuild.worker), build(presets.esbuild.manifest)]);
