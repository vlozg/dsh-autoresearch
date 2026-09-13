# dsh-plugin-autoresearch

DSH port of [pi-autoresearch](https://github.com/nicobailon/pi-autoresearch): an autonomous experiment loop for hard problems with metrics that never reach a perfect score. The agent tries, benchmarks, keeps or discards, and repeats — without a DSH goal that it could otherwise mark "complete".

## What it provides

**Agent tools**

- `init_experiment` — create an experiment session (name, primary metric + unit + direction, optional round cap). Arms the plugin-side auto-resume loop (pi-style idle followups, not DSH goals).
- `run_experiment` — run the benchmark command; captures METRIC lines, wall time, and output; gates on `.auto/checks.sh` when present.
- `log_experiment` — record the result: keep (only when the primary metric improved), discard / crash / checks_failed (auto-revert), plus structured Side Information that survives reverts.

**Web UI (better-sidebar)**

- An "Autoresearch" tab in the right sidebar (flask icon, badge with run state) that auto-opens when the active conversation gains an experiment session.
- Dashboard: session card (metric, direction, segment, workdir), BEST / BASELINE / CONFIDENCE / RUNS, per-run history, live running-tail output, Stop loop / Resume loop.
- Toolview cards replace the raw JSON for `init_experiment` / `run_experiment` / `log_experiment` calls in the conversation.

**Local HTTP** (same-origin only; cross-site `sec-fetch-site` and non-JSON POSTs are refused)

- `GET /autoresearch/state?sessionId=` — one-shot snapshot
- `GET /autoresearch/events` — SSE: named `state` / `running` events, 15 s heartbeat
- `POST /autoresearch/stop` / `POST /autoresearch/resume` — loop + run control (JSON body)

## Layout

- `src/host/` — plugin face: tools, experiment service, JSONL persistence, SSE/fence HTTP, skill (`autoresearch-create`), pi-style idle-resume hooks.
- `src/client/` — client face: store (SSE), dashboard views, better-sidebar tab + auto-open, toolview registrations.
- `tests/` — vitest suite (59 tests, 10 files).

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
