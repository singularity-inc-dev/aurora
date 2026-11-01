-- Thin version 1, piece E: conflicts the merge replay found between ready
-- branches (counted by piece F), and the ones each handback email shows.
CREATE TABLE IF NOT EXISTS "plugin_vision_and_tom_d7896c8063".conflicts (
  company_id text NOT NULL,
  task_a text NOT NULL,
  task_b text NOT NULL,
  head_a text NOT NULL,
  head_b text NOT NULL,
  owner_a text NOT NULL,
  owner_b text NOT NULL,
  files text NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, task_a, task_b, head_a, head_b)
);

ALTER TABLE "plugin_vision_and_tom_d7896c8063".briefings ADD COLUMN IF NOT EXISTS conflicts text NOT NULL DEFAULT '[]';
