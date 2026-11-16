-- Milestone 6: run flags that nothing else records (tool error, timeout, budget stop).
-- Failed checks, "not tested" and rejected are read from task_events, not stored here.
-- One row per task and kind; a repeat updates the detail.
CREATE TABLE IF NOT EXISTS "plugin_vision_and_tom_d7896c8063".run_flags (
  task_id text NOT NULL,
  company_id text NOT NULL,
  kind text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, kind)
);

CREATE INDEX IF NOT EXISTS run_flags_company ON "plugin_vision_and_tom_d7896c8063".run_flags (company_id);
