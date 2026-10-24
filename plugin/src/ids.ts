/** The plugin's key in Paperclip. Kept from the night-only plan: Paperclip ties the install and its settings to it. */
export const PLUGIN_ID = "vision-and-tom.night-agents";
export const HANDOFF_ORIGIN = `plugin:${PLUGIN_ID}:handoff` as const;
export const PLAN_ORIGIN = `plugin:${PLUGIN_ID}:handover-plan` as const;
export const HANDOVER_TASK_ORIGIN = `plugin:${PLUGIN_ID}:handover-task` as const;
export const HANDOVER_TICK_JOB = "handover-tick";
