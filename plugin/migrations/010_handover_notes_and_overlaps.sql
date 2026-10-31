-- The owner's handover note per task ("done when", the tests that prove it), locked
-- when the owner hands the task over, and the plugin's own verdict on it at handback.
ALTER TABLE "plugin_vision_and_tom_d7896c8063".task_events ADD COLUMN IF NOT EXISTS note_title text;
ALTER TABLE "plugin_vision_and_tom_d7896c8063".task_events ADD COLUMN IF NOT EXISTS done_when text;
ALTER TABLE "plugin_vision_and_tom_d7896c8063".task_events ADD COLUMN IF NOT EXISTS done_when_tests text NOT NULL DEFAULT '[]';
ALTER TABLE "plugin_vision_and_tom_d7896c8063".task_events ADD COLUMN IF NOT EXISTS note_source text;
ALTER TABLE "plugin_vision_and_tom_d7896c8063".task_events ADD COLUMN IF NOT EXISTS note_locked_at timestamptz;
ALTER TABLE "plugin_vision_and_tom_d7896c8063".task_events ADD COLUMN IF NOT EXISTS done_when_result text;
ALTER TABLE "plugin_vision_and_tom_d7896c8063".task_events ADD COLUMN IF NOT EXISTS done_when_evidence text NOT NULL DEFAULT '[]';
ALTER TABLE "plugin_vision_and_tom_d7896c8063".task_events ADD COLUMN IF NOT EXISTS done_when_head text;

-- Teammate overlap check at handback: per task, how many other branches change the
-- same files, and how many of those would conflict (latest handback email).
ALTER TABLE "plugin_vision_and_tom_d7896c8063".task_events ADD COLUMN IF NOT EXISTS overlaps integer;
ALTER TABLE "plugin_vision_and_tom_d7896c8063".task_events ADD COLUMN IF NOT EXISTS would_be_conflicts integer;

-- Every overlapping pair of branches, once per pair of branch versions.
CREATE TABLE IF NOT EXISTS "plugin_vision_and_tom_d7896c8063".branch_overlaps (
  company_id text NOT NULL,
  task_a text NOT NULL,
  task_b text NOT NULL,
  head_a text NOT NULL,
  head_b text NOT NULL,
  owner_a text NOT NULL,
  owner_b text NOT NULL,
  files text NOT NULL DEFAULT '[]',
  conflict boolean NOT NULL,
  conflict_files text NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, task_a, task_b, head_a, head_b)
);
