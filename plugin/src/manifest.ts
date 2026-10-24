import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { instanceConfigSchema } from "./config.js";
import { NIGHT_TICK_JOB, PLUGIN_ID } from "./ids.js";
import { HANDOFF_TOOL, PROPOSE_TOOL, RUN_CHECKS_TOOL } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.5.0",
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
    "agents.pause",
    "api.routes.register",
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
  // Used only by the email service. Board-only: agents can never call them.
  apiRoutes: [
    { routeKey: "briefings-pending", method: "GET", path: "/briefings/pending", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "briefing-sent", method: "POST", path: "/briefings/:briefingId/sent", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "link-preview", method: "POST", path: "/links/preview", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "link-execute", method: "POST", path: "/links/execute", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "link-publish-result", method: "POST", path: "/links/publish-result", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "prs-waiting", method: "GET", path: "/prs/waiting", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "pr-update", method: "POST", path: "/prs/update", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "invite-create", method: "POST", path: "/invites", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "invite-preview", method: "POST", path: "/invites/preview", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "invite-claim", method: "POST", path: "/invites/claim", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "invite-finish", method: "POST", path: "/invites/finish", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
  ],
};

export default manifest;
