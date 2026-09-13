/**
 * dsh-plugin-autoresearch — host face.
 *
 * Registers:
 * - the three autoresearch tools (init/run/log_experiment)
 * - the autoresearch-create skill
 * - the dashboard HTTP routes (state / SSE events / stop / resume)
 * - the pi-style auto-resume idle injector (no DSH goals by design)
 *
 * All state lives in the workspace's .auto/ contract, so the loop survives
 * server restarts and is inspectable on the phone via the sidebar.
 */

import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { ExperimentService, type PluginConfig } from "./experiment";
import { buildAutoResearchTools } from "./tools";
import { AutoResumeInjector } from "./resume";
import { registerAutoResearchHttp } from "./http";
import { autoresearchCreateSkill } from "./skill";

export const name = "dsh-plugin-autoresearch";
// "agents" must be declared here: the cordis context proxy throws
// cannot-get-property-without-inject otherwise — this bit detect()
// (the mystery bare HTTP 400) and would bite the auto-resume hooks too.
export const inject = ["tools", "agents"] as const;

/** Runtime configuration schema (validated and defaulted by Cordis). */
export const Config = Schema.object({
  defaultExperimentTimeoutSeconds: Schema.number()
    .default(600)
    .description("Default run_experiment timeout in seconds."),
  defaultChecksTimeoutSeconds: Schema.number()
    .default(300)
    .description("Default .auto/checks.sh timeout in seconds."),
  autoActivateLoop: Schema.boolean()
    .default(true)
    .description(
      "Auto-enable the loop when a session whose .auto/log.jsonl already has runs reopens in the same directory.",
    ),
});

export type Config = PluginConfig;

export function apply(ctx: Context, config: Partial<PluginConfig> = {}): void {
  const resolved: PluginConfig = {
    defaultExperimentTimeoutSeconds: config.defaultExperimentTimeoutSeconds ?? 600,
    defaultChecksTimeoutSeconds: config.defaultChecksTimeoutSeconds ?? 300,
    autoActivateLoop: config.autoActivateLoop ?? true,
  };

  const service = new ExperimentService(ctx, resolved);

  // --- tools -----------------------------------------------------------------
  const tools = buildAutoResearchTools(service);
  const toolDisposers = [
    ctx.tools.register(tools.initExperiment),
    ctx.tools.register(tools.runExperiment),
    ctx.tools.register(tools.logExperiment),
  ].filter((dispose): dispose is () => void => typeof dispose === "function");

  // --- skill -----------------------------------------------------------------
  const skills = ctx.get("skills") as
    | { register: (skill: { name: string; description: string; content: string; source: string }) => () => void }
    | undefined | null;
  const disposeSkill =
    skills != null && typeof skills.register === "function"
      ? skills.register({ ...autoresearchCreateSkill(), source: "bundled" })
      : undefined;

  // --- auto-resume injector -----------------------------------------------------
  const injector = new AutoResumeInjector(ctx, service);
  const disposeInjector = injector.arm();

  // --- dashboard HTTP ------------------------------------------------------------
  // Rides ctx.inject: the webServer may be provided after this plugin loads
  // (and never appears in headless compositions — the callback just never runs).
  let removeRoutes: () => void = () => {};
  ctx.inject(["webServer"], (webServer) => {
    removeRoutes = registerAutoResearchHttp(webServer, service);
    return () => removeRoutes();
  });

  // Unload cleanup: tools unregister, dashboard routes stop, idle timers clear.
  ctx.effect(() => {
    return () => {
      for (const dispose of toolDisposers.splice(0)) dispose();
      disposeSkill?.();
      disposeInjector();
      removeRoutes();
    };
  });
}

export type { PluginConfig, ExperimentService };
