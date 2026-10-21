import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { instanceConfigSchema } from "./config.js";
import { NIGHT_TICK_JOB, PLUGIN_ID } from "./ids.js";
import { HANDOFF_TOOL, PROPOSE_TOOL, RUN_CHECKS_TOOL } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.3.2",
  displayName: "Vision and Tom",
  description:
    "One personal night agent per teammate. Agents use only their owner's keys, hand off via board tickets, and change nothing shared until the owner approves.",
  author: "Vision and Tom",
  categories: ["automation"],
  // Each capability is needed by a feature; routes.ts lists the ones we must never ask for.
  capabilities: [
    "secrets.read-ref",
    "agents.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.create",
    "issue.documents.write",
    "execution.workspaces.read",
    "agent.tools.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "companies.read",
    "issue.interactions.create",
    "issue.interactions.read",
    "jobs.schedule",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema,
  database: {
    namespaceSlug: "vision_and_tom",
    migrationsDir: "migrations",
    // Read-only: tonight's spend per agent for the night budget cap.
    coreReadTables: ["cost_events"],
  },
  jobs: [
    {
      jobKey: NIGHT_TICK_JOB,
      displayName: "Night routine tick",
      description: "Opens evening plans, starts approved tasks at night, enforces time limits, retries and the night budget cap.",
      schedule: "*/5 * * * *",
    },
  ],
  tools: [HANDOFF_TOOL, RUN_CHECKS_TOOL, PROPOSE_TOOL],
};

export default manifest;
