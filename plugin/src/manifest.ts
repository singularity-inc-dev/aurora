import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { instanceConfigSchema } from "./config.js";
import { HANDOVER_TICK_JOB, PLUGIN_ID } from "./ids.js";
import { HANDOFF_TOOL, PROPOSE_TOOL, RUN_CHECKS_TOOL } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.11.0",
  displayName: "Vision and Tom",
  description:
    "Aurora: each teammate hands their own agent exactly the tasks they chose, with a note per task (what, done when, limits), now or at their scheduled time. Agents use only their owner's keys, hand off via board tickets, and change nothing shared until the owner approves.",
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
    // Read-only: the project's repository folder, for CODEOWNERS in the pre-handover check.
    "projects.read",
    "project.workspaces.read",
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
    // Read-only: each handover's spend per agent, for its budget cap.
    coreReadTables: ["cost_events"],
  },
  jobs: [
    {
      jobKey: HANDOVER_TICK_JOB,
      displayName: "Handover tick",
      description: "Starts the tasks each owner handed over in their handover window, enforces each task's time and budget, retries and the budget cap, and builds the handback.",
      schedule: "*/5 * * * *",
    },
  ],
  tools: [HANDOFF_TOOL, RUN_CHECKS_TOOL, PROPOSE_TOOL],
  // Used by the Aurora service only (the plugin refuses every other caller, see worker.ts). Board-only: agents can never call them.
  apiRoutes: [
    { routeKey: "briefings-pending", method: "GET", path: "/briefings/pending", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "briefing-sent", method: "POST", path: "/briefings/:briefingId/sent", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "link-preview", method: "POST", path: "/links/preview", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "link-execute", method: "POST", path: "/links/execute", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "link-publish-result", method: "POST", path: "/links/publish-result", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "links-stuck", method: "GET", path: "/links/stuck", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "link-recover", method: "POST", path: "/links/recover", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "prs-waiting", method: "GET", path: "/prs/waiting", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "pr-update", method: "POST", path: "/prs/update", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "handover-start", method: "POST", path: "/handovers/start", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "handover-withdraw", method: "POST", path: "/handovers/withdraw", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "handover-suggest", method: "POST", path: "/handovers/suggest", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "caller", method: "GET", path: "/caller", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "handover-status", method: "GET", path: "/handovers/status", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "numbers", method: "GET", path: "/numbers", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "numbers-csv", method: "GET", path: "/numbers/csv", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "invite-create", method: "POST", path: "/invites", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "invite-preview", method: "POST", path: "/invites/preview", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "invite-claim", method: "POST", path: "/invites/claim", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
    { routeKey: "invite-finish", method: "POST", path: "/invites/finish", auth: "board", capability: "api.routes.register", companyResolution: { from: "body", key: "companyId" } },
  ],
};

export default manifest;
