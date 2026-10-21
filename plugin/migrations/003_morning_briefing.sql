-- M4: morning briefings and the actions their signed links may take.
ALTER TABLE "plugin_vision_and_tom_d7896c8063".task_events ADD COLUMN IF NOT EXISTS checks_head text;
ALTER TABLE "plugin_vision_and_tom_d7896c8063".task_events ADD COLUMN IF NOT EXISTS decision_action_id text;

-- One briefing per person per night.
CREATE TABLE IF NOT EXISTS "plugin_vision_and_tom_d7896c8063".briefings (
  id text NOT NULL UNIQUE,
  company_id text NOT NULL,
  owner text NOT NULL,
  night_date text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  items text NOT NULL DEFAULT '[]',
  notes text NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  PRIMARY KEY (company_id, owner, night_date)
);

-- One row per link. The id is the idempotency key: a link acts at most once.
CREATE TABLE IF NOT EXISTS "plugin_vision_and_tom_d7896c8063".link_actions (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  owner text NOT NULL,
  task_id text NOT NULL,
  kind text NOT NULL,
  briefing_id text NOT NULL,
  workspace_cwd text,
  branch text,
  base_ref text,
  expected_head text,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'new',
  result text,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
