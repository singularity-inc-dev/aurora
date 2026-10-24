-- M5: invite links (one row per invite; the id is the one-time key) and
-- pull requests opened by Approve that wait for review on GitHub.
CREATE TABLE IF NOT EXISTS "plugin_vision_and_tom_d7896c8063".invites (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  email text NOT NULL,
  timezone text NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'new',
  result text,
  user_id text,
  agent_id text,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "plugin_vision_and_tom_d7896c8063".pull_requests (
  task_id text PRIMARY KEY,
  company_id text NOT NULL,
  owner text NOT NULL,
  action_id text NOT NULL,
  number integer NOT NULL,
  url text NOT NULL,
  head_sha text NOT NULL,
  state text NOT NULL DEFAULT 'waiting',
  reason text,
  merge_sha text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
