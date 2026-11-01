-- Thin version 1, piece A: an invite carries the system user, Paperclip SSH
-- environment and checks key that vt-invite made for the new person's agent.
ALTER TABLE "plugin_vision_and_tom_d7896c8063".invites ADD COLUMN IF NOT EXISTS agent_environment_id text;
ALTER TABLE "plugin_vision_and_tom_d7896c8063".invites ADD COLUMN IF NOT EXISTS agent_user text;
ALTER TABLE "plugin_vision_and_tom_d7896c8063".invites ADD COLUMN IF NOT EXISTS checks_key_secret_id text;
