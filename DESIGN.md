# dsh-autoresearch — design

Autonomous experiment loop for DSH (port of [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch)),
with a live **better-sidebar** tab for navigating, monitoring, and reviewing experiment results.

References (cloned under `refs/`, gitignored):
- `refs/pi-autoresearch` — the original pi extension (tools + auto-resume loop + dashboard).
- `refs/BrowserSkill` — Tencent/BrowserSkill, `packages/dsh-plugin-browserskill` is the reference
  for a full-featured DSH tool plugin (tools + skill + SSE routes + sidebar integration).
- installed sidebar: `dsh-better-sidebar@0.18.0` — https://github.com/omdsh-dev/DSH-better-sidebar
  (installed in `~/.dsh/profiles/web` as a bundle; exposes `ctx.betterSidebar` service).

---

## 1. What exists (research findings)

### 1.1 DSH plugin anatomy (from `dsh_plugins/my-first-plugin` + BrowserSkill plugin)

A DSH web plugin is an npm package with two faces:

| Piece | Role |
|---|---|
| `package.json` → `dsh.bundle.patch` | points at `cordis.patch.yml` which `insert`s one composition row; `dsh plugin --profile web add <dir>` installs it as a **live symlink** into the profile |
| host face `main` (`lib/index.js`) | ordinary Cordis plugin on the host: `inject` services, `Config` schema, defines tools |
| client face `exports["./client"]` (`lib/client.js`) | CJS closure-factory bundle loaded by the browser module table; named exports `inject` + `apply(ctx)` |
| `tsdown.config.ts` | two-face build; client externals = module table (`react`, `@deepseek-ai/dsh-client-*`…) — everything else must be a real dep and gets bundled |

Dev loop (HMR): `pnpm watch` in the plugin repo + `dsh web` running → client edits hot-reload
without page refresh; host edits need a server restart.

### 1.2 better-sidebar service API (`ctx.betterSidebar`, v0.18.0)

Published to the client cordis context as `betterSidebar`; consumers do
`ctx.inject(["betterSidebar"], cb)` (optional — no-op in profiles without it). Key surface:

- `registerTab(TabDescriptor)` — `id`, `title`, `icon`, `single`, `badge(ctx,scope,state)`,
  `component(props: TabComponentProps)`, lifecycle callbacks, settings rows. Returns disposer.
- `openTab({ type, path, title, meta }, scope?)` — content opens (`path` seed) auto-expand the panel.
- `registerFileViewer(FileViewerDescriptor)` — `exts`, `detect(path, head)`, `priority`,
  `fetchStrategy`, `load()`, `component(FileViewerProps)`.
- `openFile(scope, path, title)` — open a file in the sidebar editor.
- `updateTab`, `activateTab`, `closeTab`, `getSnapshot`, `subscribeState`.
- Capability gating via `features` list ('badge', 'tabMeta', 'pluginSettings', ...).

BrowserSkill uses exactly this pattern (`src/client/observation-sidebar.tsx`): register a
single-instance tab with a badge, auto-open (content seed) when a browser session appears,
fall back to a floating `shell.overlay` card when the sidebar plugin is absent.

### 1.3 Host seams a plugin can use (from BrowserSkill plugin)

- `inject = ["tools"]` + `ctx.tools.register(defineTool({...}))` (`@deepseek-ai/dsh-tools`) — model tools.
- Skill seam: register a skill (catalog entry resident, body on demand) — browser-skill ships
  `browser-skill` this way; can coexist with a same-name CLI skill.
- `ctx.inject(["webServer"], …)` → `webServer.register({ kind, path, handler })` for HTTP + SSE,
  guarded by a loopback/Origin/CSRF fence (see `observation-http.ts` — worth copying verbatim).
- Client: keyed toolviews via `tool.call.toolview` slot (`key: <toolname>`), `shell.overlay` seat,
  `sessions` service for attachments.
- Long-running tools are fine (bsk tools run minutes); interrupt via `exec.signal`.

### 1.4 pi-autoresearch engine (the logic to port)

- Session files in `.auto/` at the workdir root: `prompt.md`, `measure.sh`, `log.jsonl`,
  `ideas.md`, `checks.sh`, `config.json`, `hooks/{before,after}.sh` (+ legacy flat names).
- Tools:
  - `init_experiment` — name/metric/unit/direction; re-init inserts a new config header (segment++).
  - `run_experiment` — refuses non-measure.sh commands once measure.sh exists; times wall-clock,
    captures output/tail, parses `METRIC name=value` lines, runs `checks.sh` after passing
    benchmarks (separate timeout, last-80-lines on failure); guards max experiments.
  - `log_experiment` — status keep/discard/crash/checks_failed; `keep` → `git add -A && git commit`;
    discard/crash/checks_failed → `git checkout -- . + git clean` excluding `.auto/`; computes
    confidence = |best_delta| / MAD of same-segment results; appends the entry to log.jsonl.
- Auto-resume: on idle it sends a follow-up user message ("pick the most promising hypothesis …
  call run_experiment + log_experiment") with guards (turn limit, consecutive-failure limit).
- Hooks: `before`/`after.sh` get a JSON payload on stdin; stdout is delivered to the agent as steer.
- Compaction: state survives context compaction via log.jsonl being the source of truth.
- Dashboard: results table + confidence pill + live running spinner.

### 1.5 DSH-native equivalents for the loop

| pi mechanism | DSH-native answer |
|---|---|
| extension widget / `/autoresearch dashboard` | **better-sidebar tab** (live SSE) + floating overlay fallback |
| `/autoresearch export` (browser dashboard) | sidebar tab replaces it (optionally keep an HTML export later) |
| auto-resume `sendUserMessage(followUp)` | **plugin-side idle injection (pi-style)** — DECIDED: do NOT use DSH goals. Goals let the model self-terminate by marking the goal complete, but autoresearch loops on hard problems whose metric may never reach a perfect score; the loop must not be terminable by the model. Host listens for `agent/status: idle` and delivers a custom resume user message via `agent.followup(createUserMessage(...))` with pi's guards (turn limit, consecutive-failure limit, debounce window) |
| skills (autoresearch-create) | plugin-registered skill via the skill seam |
| toolviews (terminal widget) | keyed `tool.call.toolview` cards for run/log_experiment in the chat |
| hooks → steer | same `.auto/hooks` contract; stdout goes back as tool-result text (no cross-turn steer needed in DSH's loop) |

---

## 2. Proposed architecture

Package `dsh-plugin-autoresearch` (repo: `projects/dsh_autoresearch/dsh-plugin-autoresearch/`).

```
src/
  host/
    index.ts          apply(): inject ["tools"], Config, wires everything
    tools.ts          init_experiment / run_experiment / log_experiment (defineTool)
    experiment-service.ts  session state, log.jsonl read/append, SSE pub/sub
    paths.ts          .auto/ layout (port)
    jsonl.ts          entry schema + config header (port)
    metrics.ts        METRIC line parser + MAD confidence (port)
    hooks.ts          .auto/hooks/{before,after}.sh (port)
    http.ts           /autoresearch/state | /events (SSE) | /stop  (+ loopback fence)
  client/
    index.tsx         apply(): keyed toolviews + overlay + ctx.inject(["betterSidebar"], tab)
    autoresearch-tab.tsx   the sidebar tab (results table, chart, controls)
    store.ts          EventSource + fetch store (port of observation-store pattern)
  skill/
    autoresearch-create/SKILL.md   setup + loop rules (adapted: create_goal, DSH tools)
cordis.patch.yml      composition row
tsdown.config.ts      two-face build
```

### Data flow

1. Model calls `init_experiment`/`run_experiment`/`log_experiment` → host executes (child_process,
   timeout, captures), updates log.jsonl + in-memory state, publishes to SSE subscribers.
2. Client store (EventSource `/autoresearch/events`) feeds:
   - the sidebar tab (table + chart + confidence + running spinner),
   - keyed toolview cards in the transcript,
   - a floating overlay fallback when better-sidebar is absent.
3. Sidebar actions: open `prompt.md`/`log.jsonl` (openFile), stop a running command (POST /stop),
   per-run output files (stored `.auto/runs/<n>.log`) opened in the editor.

### Sidebar tab UX ("Autoresearch", single-instance, badge = running/last status)

**Requirement (user): the tab must be UI-rich and phone-viewable.** pi's CLI UI was the
pain point — the user had to open raw `.auto/` files to see data. The sidebar tab is the
product: everything readable from the phone (status, table, chart, confidence, controls)
lives in the tab, not in terminal widgets.

- Header row: name · metric (unit, direction) · segment · baseline/best · confidence pill
  (green ≥2.0×, yellow 1–2×, red <1× — same thresholds as pi).
- Sparkline of metric over runs (hand-rolled SVG, zero deps) with keep/discard/crash markers.
- Results table: #, commit, metric, Δ vs best, status, description; row expand → ASI + output tail;
  "open run log" → openFile.
- Live row while running: spinner + elapsed + command.
- Footer buttons: open prompt.md · open log.jsonl · stop.

### MVP slices

- **M1 — engine**: host tools + `.auto/` contract + experiment-service + SSE routes; e2e-verified
  with a dummy measure.sh project (loop works from CLI host, no UI).
- **M2 — UI**: client half — toolviews + better-sidebar tab + auto-open + badge (+ overlay fallback).
- **M3 — polish**: log.jsonl file viewer, sparkline, hooks port, ideas.md viewer, per-run output files,
  finalize skill (branch splitting), HTML export (optional).

### Risks / open points

- ~~Auto-resume seam~~ RESOLVED: `ReactLoopAgent.followup(userMessage)` + idle-status listener (verified against the goal-round-driver). Loop mode (on/off) is plugin-side state; the injected message carries `{kind:'plugin', plugin:'autoresearch', form:'notice'}` source.
- Tool long-calls: confirm tool timeout policy for minutes-long `run_experiment`
  (tool-call-timeout-policy package exists; bsk precedent suggests OK).
- Client face bundle: keep deps zero (hand-rolled SVG chart, no codemirror/recharts).
- git operations from the plugin must exclude `.auto/` (port pi's exact exclude globs).
```
