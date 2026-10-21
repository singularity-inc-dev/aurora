import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { parseSettings } from "./config.js";

const plugin = definePlugin({
  async setup(ctx) {
    // Read-only summary of who is configured. Secret refs are left out on purpose.
    ctx.data.register("people", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : undefined;
      const parsed = parseSettings(await ctx.config.get(companyId));
      if (!parsed.ok) return { ok: false, errors: parsed.errors };
      return {
        ok: true,
        people: parsed.settings.people.map((p) => ({
          email: p.email,
          agentId: p.agentId,
          timezone: p.timezone,
          nightStartHour: p.nightStartHour,
          maxTasksPerNight: p.maxTasksPerNight,
          nightBudgetCapCents: p.nightBudgetCapCents,
          keyNames: p.secrets.map((s) => ({ name: s.name, access: s.access })),
        })),
      };
    });
  },

  async onValidateConfig(config) {
    const parsed = parseSettings(config);
    return parsed.ok ? { ok: true } : { ok: false, errors: parsed.errors };
  },

  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
