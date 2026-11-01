-- Replay (evals): real handover tasks saved from the event log, so a baseline
-- prompt and a candidate prompt can be run on the same inputs.

-- The commit a task's work forked from, recorded next to checks_head when the
-- checks gate runs (the merge base with the branch the task is compared with).
ALTER TABLE "plugin_vision_and_tom_d7896c8063".task_events ADD COLUMN IF NOT EXISTS checks_base text;

-- One row per saved task. Never updated after it is saved: a replay must see the
-- same inputs every time, even when the ticket is edited later.
CREATE TABLE IF NOT EXISTS "plugin_vision_and_tom_d7896c8063".saved_tasks (
  task_id text PRIMARY KEY,
  company_id text NOT NULL,
  owner text NOT NULL,
  agent text NOT NULL,
  task_kind text NOT NULL,
  identifier text,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  inputs_redacted boolean NOT NULL DEFAULT false,
  description_truncated boolean NOT NULL DEFAULT false,
  base_ref text,
  base_sha text NOT NULL,
  head_sha text NOT NULL,
  repo_url text,
  checks_result text,
  outcome text,
  reject_reason text,
  started_at timestamptz,
  finished_at timestamptz,
  saved_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saved_tasks_company ON "plugin_vision_and_tom_d7896c8063".saved_tasks (company_id, saved_at);
