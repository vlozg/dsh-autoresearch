# dsh-autoresearch

DSH plugin porting [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch): an autonomous
experiment loop for hard problems whose metric never reaches a perfect score. The agent proposes a
hypothesis, benchmarks it, keeps or discards the result, and repeats — plus a live **better-sidebar**
dashboard for monitoring and reviewing runs from the browser, phone included.

The loop deliberately does not run on DSH goals: a goal can be marked complete by the model, and
these loops target problems that never reach a perfect score. Auto-resume is plugin-side instead
(idle followups, pi-style, with pi's guards).

## Repository layout

| Path | What it is |
| --- | --- |
| `dsh-plugin-autoresearch/` | the plugin: host face (hexagonal) + client face (FSD) |
| `dsh-plugin-autoresearch/docs/ARCHITECTURE.md` | the layering standard and review checklist, machine-checked on every test run |
| `dsh-plugin-autoresearch/README.md` | plugin docs: tools, HTTP routes, install into a DSH profile, live reload |
| `DESIGN.md` | design + research notes behind the port (DSH plugin anatomy, better-sidebar API, slices, risks) |
| `refs/pi-autoresearch/` | upstream reference, pinned git submodule — the revision this port was written against |

## Quick start

```bash
git clone --recursive git@github.com:vlozg/dsh-autoresearch.git
cd dsh-autoresearch/dsh-plugin-autoresearch
pnpm install
```

`--recursive` matters: `refs/pi-autoresearch` is a submodule (upstream `davebcn87/pi-autoresearch`,
currently pinned at `939ede8`). An existing clone catches up with `git submodule update --init`.

### Gates

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest — 92 tests across 14 files, architecture conformance included
pnpm build       # tsdown -> lib/index.mjs (host) + lib/client.cjs (client)
```

All three are expected to run clean on every commit; `pnpm build` also enforces client-bundle
purity (no `@deepseek-ai/*` import outside the module-table externals).

## Architecture at a glance

```
host   (hexagonal)  domain <- app <- adapters . infra   composed in src/host/index.ts
client (FSD)        shared <- entities <- features <- src/client/index.ts
contract            src/shared/wire.ts   — type-only, imported by both faces
```

The host's pure kernel (`domain/`) has no node builtins and no framework. The client's only door to
the cross-face contract is `src/client/shared/wire.ts`. `docs/ARCHITECTURE.md` holds the full rules,
the review checklist, the change recipes, and the accepted debt.

## Status

Implemented and tested end to end: the three agent tools (`init_experiment`, `run_experiment`,
`log_experiment`), the `.auto/` session contract (measure / checks / hooks / log.jsonl), pi-style
auto-resume, the SSE routes, the better-sidebar dashboard with toolview cards, and past-session
detection across conversation workdirs. 92 tests pass and both bundles build.

## Provenance

A port of [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) (MIT, © Tobi Lutke and
David Cortés), pinned in `refs/pi-autoresearch`. [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill)
was the reference for a full-featured DSH tool plugin and is not vendored — see `DESIGN.md`.
