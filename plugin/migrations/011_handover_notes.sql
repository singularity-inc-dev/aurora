-- The owner's handover note: one row per task handed over (ARCHITECTURE.md, data
-- model "HandoverNote"). The single place that says what the agent was asked to
-- do, how the owner will know it is done, and the task's limits. Locked when the
-- owner taps Hand over; nothing the agent does changes it.
--   status: draft (an agent suggestion, or not yet handed over), queued (handed
--   over for the owner's next scheduled window), handed_over (in a handover run,
--   handover_key says which), withdrawn.
CREATE TABLE IF NOT EXISTS "plugin_vision_and_tom_d7896c8063".handover_notes (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  owner text NOT NULL,
  agent_id text NOT NULL,
  task_id text NOT NULL,
  source text NOT NULL,
  status text NOT NULL,
  schedule text,
  handover_key text,
  title text NOT NULL,
  what text NOT NULL,
  done_when text NOT NULL DEFAULT '',
  claims text NOT NULL DEFAULT '[]',
  max_minutes integer NOT NULL,
  budget_cents integer NOT NULL,
  ticket_digest text,
  submitted_by text,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS handover_notes_owner ON "plugin_vision_and_tom_d7896c8063".handover_notes (company_id, owner, status);
CREATE INDEX IF NOT EXISTS handover_notes_task ON "plugin_vision_and_tom_d7896c8063".handover_notes (task_id, created_at);
-- A ticket waits for the schedule in at most one note.
CREATE UNIQUE INDEX IF NOT EXISTS handover_notes_one_queued ON "plugin_vision_and_tom_d7896c8063".handover_notes (task_id) WHERE status = 'queued';
