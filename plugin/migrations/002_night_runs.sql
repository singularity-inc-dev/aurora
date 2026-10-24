-- One row per person per night: the "night routine". The primary key makes a
-- second routine for the same person and night impossible.
CREATE TABLE IF NOT EXISTS "plugin_vision_and_tom_d7896c8063".night_runs (
  company_id text NOT NULL,
  owner text NOT NULL,
  agent_id text NOT NULL,
  night_date text NOT NULL,
  status text NOT NULL,
  plan_issue_id text,
  interaction_id text,
  task_ids text NOT NULL DEFAULT '[]',
  current_index integer NOT NULL DEFAULT -1,
  current_attempt integer NOT NULL DEFAULT 0,
  step_started_at timestamptz,
  stop_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, owner, night_date)
);
