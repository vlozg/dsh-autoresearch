# dsh-plugin-autoresearch

DSH port of [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch): an autonomous experiment loop for hard problems with metrics that never reach a perfect score. The agent tries, benchmarks, keeps or discards, and repeats — without a DSH goal that it could otherwise mark "complete".

## What it provides

**Agent tools**

- `init_experiment` — create an experiment session (name, primary metric + unit + direction, optional display labels, optional round cap). Arms the plugin-side auto-resume loop (pi-style idle followups, not DSH goals).
- `run_experiment` — run the benchmark command; captures METRIC lines, wall time, and output; gates on `.auto/checks.sh` when present.
- `log_experiment` — record the result: keep (only when the primary metric improved), discard / crash / checks_failed (auto-revert), optional title/summary for the dashboard, plus structured Side Information that survives reverts.

**Web UI (better-sidebar)**

- An "Autoresearch" tab in the right sidebar (flask icon, badge with run state) that auto-opens when the active conversation gains an experiment session.
- Dashboard: session card (metric, direction, segment, workdir), BEST / BASELINE / CONFIDENCE / RUNS, per-run history, live running-tail output, Stop loop / Resume loop.
- Toolview cards replace the raw JSON for `init_experiment` / `run_experiment` / `log_experiment` calls in the conversation.
- **Detect past autoresearch sessions** — a button in the dashboard (empty state, tab body, and overlay) that scans the workdirs of open conversations plus their sibling projects for existing `.auto/` trees (pi-created ones included). Workdirs that match a live conversation attach eagerly — the card appears via SSE without any tool call; the rest are listed as read-only history with name · runs · last activity · path and a hint to open a conversation in that directory.

**Local HTTP** (same-origin only; cross-site `sec-fetch-site` and non-JSON POSTs are refused)

- `GET /autoresearch/state?sessionId=` — one-shot snapshot
- `GET /autoresearch/events` — SSE: named `state` / `running` events, 15 s heartbeat
- `GET /autoresearch/detect?sessionId=` — past-session scan; returns `{ attached, unattached }` (shallow `.auto/` scan around live conversations' workdirs, depth 2, skips hidden/dependency dirs)
- `POST /autoresearch/stop` / `POST /autoresearch/resume` — loop + run control (JSON body)

## Layout

`docs/ARCHITECTURE.md` is the layering standard — machine-checked on every `pnpm test` by `tests/architecture.test.ts`.

- `src/host/` — plugin face, layered hexagonally (dependencies point inward):
  - `domain/` — pure kernel: JSONL data model (`model.ts`), metric math (`metrics.ts`), gates (`rules.ts`), resume policy (`resume-policy.ts`). No node builtins, no framework.
  - `app/` — the core: `ports.ts` (Clock, LogStore, GitVcs, CommandRunner, HookRunner, SessionScanner + output budgets), `contracts.ts` (tool params/outcomes, session shapes), `experiment-service.ts` (runtimes + SSE), one file per tool operation (`init-experiment.ts`, `run-experiment.ts`, `log-experiment.ts`), and the truncation policy (`truncate.ts`).
  - `adapters/` — node implementations of the ports: `fs-log-store.ts`, `jsonl.ts`, `node-git.ts`, `child-runner.ts`, `shell-hooks.ts`, `system-clock.ts`, `fs-scanner.ts` (past-session scan); `index.ts` exports `nodeServiceDeps()`, the ready-made kit.
  - `infra/` — DSH-facing driving edges: tool schemas (`tools.ts`), SSE HTTP (`http.ts`), skill (`skill.ts`), pi-style auto-resume (`resume.ts`).
  - `index.ts` — composition root: wires `nodeServiceDeps()` into the service.
- `src/shared/` — `wire.ts`, the typechecker-shared host↔client contract (SSE events, snapshots, detect scan): both faces `import type` — drift fails the build, not the dashboard.
- `src/client/` — client face, Feature-Sliced Design (imports point one way: shared ← entities ← features ← app):
  - `shared/` — UI atoms (`bits.tsx`), formatters (`format.ts`), and `wire.ts` — the only client file that touches the cross-face contract.
  - `entities/` — pure business objects: snapshot derivations (`derive.ts`), tool-result parsing (`parse.ts`).
  - `features/dashboard/` — the dashboard slice: entry, sidebar tab (`tab.tsx`), overlay panel (`panel.tsx`), run history (`runrow.tsx`), toolview cards (`toolviews.tsx`), SSE store (`store.ts`), colocated CSS.
  - `index.ts` — app layer: mount + registration, the public client surface.
- `tests/` — vitest suite (92 tests, 14 files): `architecture.test.ts` machine-checks the layering; `tests/client/` mirrors the client face.

## Dev

```bash
pnpm test   # vitest
pnpm build  # tsdown -> lib/index.mjs (host), lib/client.cjs (client)
```

### Install layout (one insert per id!)

As a profile bundle the plugin mounts at boot through **its own** `cordis.patch.yml`
(referenced by `dsh.bundle.patch` in this package.json; the profile lists the
package in `dsh.profile.bundles`). Boot composes every layer — bundle patches,
the profile's `cordis.patch.yml`, home patches, `--patch` overlays — into one
entry list, and the loader rejects duplicate entry ids, so the profile patch
layer must **never** also insert `id: autoresearch`:

```yaml
# /root/.dsh/profiles/web/cordis.patch.yml  — keep as [] (or config overrides only)
[]
```

A second insert crashes the next webserver boot with
`duplicate loader entry id: autoresearch`.

### Live reload without restarting the webserver

The client bundle is hot: a rebuild changes the content rev and the page picks it up on refresh — no config change needed. The host module is **not** hot in the bundle layout: it loads once per boot via the bare specifier, and node's ESM cache keeps serving the old build until restart. For host iteration without a restart, temporarily drop the package from `dsh.profile.bundles` (profile package.json) and insert it from the profile patch layer with a query buster instead:

```yaml
# profile cordis.patch.yml — ONLY while the package is not a bundle
- insert:
    - id: autoresearch
      name: /root/.../lib/index.mjs?v=2   # bump v to bust node's ESM cache
```

Removing that insert disposes the plugin; re-adding remounts it — but remember to restore the `dsh.profile.bundles` entry afterwards, or the next boot loses the plugin.
