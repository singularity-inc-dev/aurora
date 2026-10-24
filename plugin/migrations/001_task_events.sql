-- One row per task (CLAUDE.md "Event log"). Schema name is derived by Paperclip
-- from the plugin id and namespaceSlug; tests/eventlog.test.ts checks it.
CREATE TABLE IF NOT EXISTS "plugin_vision_and_tom_d7896c8063".task_events (
  task_id text PRIMARY KEY,
  company_id text NOT NULL,
  owner text NOT NULL,
  agent text NOT NULL,
  task_kind text NOT NULL,
  proposed_at timestamptz,
  approved_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  checks_result text,
  outcome text,
  reject_reason text,
  handed_off_to text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_events_company_owner ON "plugin_vision_and_tom_d7896c8063".task_events (company_id, owner);
