/**
 * The autoresearch-create skill (port of pi's skills/autoresearch-create,
 * adapted to DSH: no goal tools — the loop is plugin-side auto-resume; the
 * dashboard lives in the DSH sidebar).
 */

export interface SkillDef {
  name: string;
  description: string;
  content: string;
}

const SKILL_CONTENT = `# Autoresearch

Run a sustained experiment loop that measurably improves one primary metric.
The plugin drives the loop for you: after each turn it re-prompts you to run
the next iteration. NEVER STOP the loop yourself — only stop when the
max-experiments limit is reached (the tool tells you).

## When to use

The user asks to "optimize X", "improve Y", or "run autoresearch on Z" with a
measurable metric (latency, size, accuracy, score...).

## Setup

1. Create \`.auto/prompt.md\`: the full task description, constraints, and the
   metric to optimize (goal, rules, what counts as cheating).
2. Create \`.auto/measure.sh\` (chmod +x): the benchmark. It must print the
   primary metric as the LAST line in the format:
   \`METRIC <name>=<value>\`
   (e.g. \`METRIC total_us=12345\`). It may print more METRIC lines — the first
   becomes the primary metric and the rest are tracked automatically.
3. Optionally create \`.auto/checks.sh\`: correctness gate run after a passing
   benchmark (exit 0 = pass). A failed check is logged as checks_failed.
4. Optionally create \`.auto/ideas.md\`: a backlog of hypotheses to try.
5. Call \`init_experiment\` with the session name, metric name, unit, direction.
6. Run the benchmark with \`run_experiment\`, then \`log_experiment\` (description as
   \`Short title: what happened and why\`).

## Loop rules

- After \`log_experiment\`, immediately start the next iteration. NEVER STOP.
- Only stop when the tool output says the maximum experiments limit is reached.
- \`keep\` only when the PRIMARY metric improved. The plugin auto-commits on
  keep and auto-reverts on discard/crash — do NOT commit or revert manually.
- Keep the working tree committed before editing: the revert restores the last
  kept state.
- Log discarded/crashed runs too — every run is data.
- Write each description as \`Short title: what happened and why\` — the sidebar
  splits on the first \`:\\u00a0\` for its title/finding rows.
- Persist hypotheses in \`.auto/ideas.md\` and diagnostics in the asi parameter
  ({"hypothesis": "...", "rollback_reason": "...", "next_action_hint": "..."})
  so reasoning survives reverts and compaction.
- Use asi.revisits_run when retrying a previously discarded idea.

## Resume

If the session was interrupted: read \`.auto/prompt.md\` for the task,
\`git log --oneline\` + \`.auto/log.jsonl\` for progress, then call
\`init_experiment\` again (starts a new segment) and continue the loop.
`;

export function autoresearchCreateSkill(): SkillDef {
  return {
    name: "autoresearch-create",
    description:
      "Run an autonomous optimization loop: set up .auto/ (prompt, measure.sh benchmark emitting METRIC lines, optional checks.sh), " +
      "then iterate run_experiment + log_experiment while the plugin auto-resumes you. Use when the user asks to optimize a metric.",
    content: SKILL_CONTENT,
  };
}
