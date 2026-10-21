import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { instanceConfigSchema } from "./config.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "vision-and-tom.night-agents",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Vision and Tom",
  description:
    "One personal night agent per teammate. Agents use only their owner's keys, hand off via board tickets, and change nothing shared until the owner approves.",
  author: "Vision and Tom",
  categories: ["automation"],
  // Milestone 1 needs only secret resolution. Later milestones add capabilities one at a time.
  capabilities: ["secrets.read-ref"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema,
};

export default manifest;
