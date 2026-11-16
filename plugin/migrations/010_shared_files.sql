-- Teammate check at handback: files two ready branches both change even though
-- git merges them cleanly (listed in the email next to the conflicts).
ALTER TABLE "plugin_vision_and_tom_d7896c8063".briefings ADD COLUMN IF NOT EXISTS shared_files text NOT NULL DEFAULT '[]';
