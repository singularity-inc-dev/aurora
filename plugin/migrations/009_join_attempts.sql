-- Robustness (spec gap 27): a join that fails halfway gives the invite back.
-- Each try takes the invite with a compare-and-swap on this counter, so only
-- one try runs at a time; a try that crashed is taken over after a while.
ALTER TABLE "plugin_vision_and_tom_d7896c8063".invites ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
