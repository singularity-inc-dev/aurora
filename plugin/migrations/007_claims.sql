-- Thin version 1, piece D: the files each task claims, and the overlaps the
-- pre-handover check caught (counted by piece F).
ALTER TABLE "plugin_vision_and_tom_d7896c8063".task_events ADD COLUMN IF NOT EXISTS claims text;
ALTER TABLE "plugin_vision_and_tom_d7896c8063".task_events ADD COLUMN IF NOT EXISTS claims_released_at timestamptz;

CREATE TABLE IF NOT EXISTS "plugin_vision_and_tom_d7896c8063".overlaps (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  handover_key text NOT NULL,
  owner text NOT NULL,
  keeper text NOT NULL,
  kind text NOT NULL,
  task_title text NOT NULL,
  claim text NOT NULL,
  against text NOT NULL,
  ticket_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS overlaps_company ON "plugin_vision_and_tom_d7896c8063".overlaps (company_id, created_at);
