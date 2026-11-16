-- Thin version 1, piece C: "night" becomes "handover", and a handover can start at
-- any time ("Hand over now"), so each one stores its own window.
ALTER TABLE "plugin_vision_and_tom_d7896c8063".night_runs RENAME TO handover_runs;
ALTER TABLE "plugin_vision_and_tom_d7896c8063".handover_runs RENAME COLUMN night_date TO handover_key;
ALTER TABLE "plugin_vision_and_tom_d7896c8063".handover_runs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'scheduled';
ALTER TABLE "plugin_vision_and_tom_d7896c8063".handover_runs ADD COLUMN IF NOT EXISTS starts_at timestamptz;
ALTER TABLE "plugin_vision_and_tom_d7896c8063".handover_runs ADD COLUMN IF NOT EXISTS ends_at timestamptz;
ALTER TABLE "plugin_vision_and_tom_d7896c8063".briefings RENAME COLUMN night_date TO handover_key;
