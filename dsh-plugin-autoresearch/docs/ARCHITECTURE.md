# Architecture standard

This file is the review contract for the repo: what goes where, which way
dependencies may point, and how every rule is checked. The layering rules are
**machine-checked** by `tests/architecture.test.ts`, which runs on every
`pnpm test`. If the architecture changes, that test's `TARGETS`/`BARE`
tables and this document change **in the same commit** — a failing
architecture test is a review comment you get for free.

Two faces, one contract:

- **host (BE)** — hexagonal architecture (ports & adapters): dependencies point inward.
- **client (FE)** — Feature-Sliced Design: imports point one way downward.
- **wire** (`src/shared/wire.ts`) — the type-only contract both faces share.

## The map

```
src/
├── shared/            wire.ts — host↔client contract: pure types, no runtime
├── host/              BE — hexagonal
│   ├── index.ts       composition root: cordis plugin; wires ports → node adapters
│   ├── infra/         driving edge: tool schemas, HTTP/SSE, auto-resume, skill
│   ├── adapters/      driven edge: node implementations of app/ports (fs, git, child, clock)
│   ├── app/           use cases: ExperimentService, init/run/log ops, ports, contracts, truncate policy
│   └── domain/        pure core: model, metric math, gates, resume policy
└── client/            FE — FSD
    ├── index.ts       app layer: the public client surface
    ├── features/      dashboard slice: entry, panel, tab, runrows, toolviews, store
    ├── entities/      business objects: snapshot derivations, tool-result parsing
    └── shared/        framework-agnostic kit: UI bits, formatters, wire gateway
```

## Host — hexagonal rules

The dependency rule: **imports point inward**. Each ring may see the rings
inside it, never outside.

| Ring | May import | Bare modules | Notes |
|---|---|---|---|
| `domain/` | domain, wire (type-only) | **none** | Pure: no node builtins, no framework, no `process`. State rebuild math + rules live here. |
| `app/` | app, domain, wire (type-only) | `node:*` value; `@deepseek-ai/*` **type-only** | Use cases + ports + budgets. Framework types (`Context`, `Agent`) are the accepted seam — see Debt. |
| `adapters/` | adapters, app, domain, wire (type-only) | `node:*` value | Implement the ports in `app/ports.ts`. Never touch `infra/`. |
| `infra/` | infra, app, domain, wire (type-only) | `node:*`, `@deepseek-ai/*` value | Driving edge: translate DSH (tools, HTTP, events) into service calls. Never touch `adapters/`. |
| `index.ts` | everything in host | `node:*`, `@deepseek-ai/*` | The only place concrete adapters are wired to the core. |

Hard rules (all enforced by the architecture test):

1. **app never imports adapters or infra.** The core sees ports
   (`ServiceDeps`), implementations are injected by the composition root.
   Adding a capability = add the port in `app/ports.ts`, implement it in
   `adapters/`, wire it in `adapters/index.ts` → `nodeServiceDeps()`.
2. **Pure logic never lives in adapters.** An adapter does I/O and translation;
   anything that encodes a rule (ordering, budgets, rebuilds) belongs in
   `domain/` or `app/`. (`truncate.ts` sits in `app/` for this reason.)
3. **The wire is type-only.** `import type` everywhere; it never ships runtime
   code to either face.

## Client — FSD rules

The dependency rule: **imports point downward**. A layer may only see the
layers below it.

| Layer | May import | Bare modules |
|---|---|---|
| `shared/` | shared | `react` |
| `entities/` | entities, shared | `react` |
| `features/` | features (same slice), entities, shared | `react` value; `@deepseek-ai/*` **type-only** |
| `index.ts` (app) | features | none |

Hard rules (all enforced by the architecture test):

1. **The wire enters through exactly one door**: `src/client/shared/wire.ts`
   is the only client file that may reach `src/shared/`. Everything else
   imports it as `shared/wire`.
2. **Slices are the unit.** All dashboard files are segments of the single
   `features/dashboard` slice and may import each other; **two slices never
   import each other**. A second UI area = a second slice, not cross-imports.
3. `pages/`/`widgets/` are deliberately absent — adopt them when a second
   route-level view or a cross-feature composite appears, not before.
4. Platform modules (`@deepseek-ai/dsh-client-*`) enter **type-only** through
   the feature entry; runtime collaboration goes through cordis services. The
   tsdown bundle purity gate enforces this at build time as well.

## The wire contract

`src/shared/wire.ts` is the single source of truth for what crosses the face
boundary: SSE events, `ExperimentSnapshot`, `RunEntry`, `DetectedSession`,
`RunningExperiment`. Adding a field there and using it in both faces is one
edit + `tsc` catches drift — no duplicate DTOs, no hand-synced mirrors.

## Enforcement gates

```bash
pnpm typecheck   # tsc --noEmit — both faces share the wire types
pnpm test        # vitest: unit + integration + architecture conformance (6 rules)
pnpm build       # tsdown — host ESM + client CJS with the bundle purity gate
```

A PR is green when all three pass. The architecture test fails with
`file:line → specifier` messages, so a layering violation is a one-line fix.

## Review checklist

Answer these mechanically — each is backed by a gate, so review can focus on
behavior and naming:

1. Does any import point the wrong way (check the two tables above)?
2. Is new *capability* behind a port, or is a concrete leaking into `app/`?
3. Is any *rule* (ordering, budget, rebuild, gate) implemented in an adapter?
4. Does a new client file import outside its slice?
5. Does the client touch `src/shared/` anywhere but `shared/wire.ts`?
6. Wire changes: `import type` only, and updated in the same commit everywhere?
7. Are domain changes still pure (no node, no framework, no process)?
8. Do new ports have a node adapter entry in `nodeServiceDeps()`?
9. Are tests colocated with the layer they cover (see below)?
10. If the layering intentionally changed: does `docs/ARCHITECTURE.md` + the
    architecture test table change with it?

## Testing standard

| What | Where | How |
|---|---|---|
| Domain math/rules | `tests/metrics.test.ts`, `jsonl.test.ts` | pure table tests, no fakes |
| Use cases (service ops) | `tests/detect.test.ts`, `tests/engine.selfcheck.test.ts` | real adapters via `nodeServiceDeps()` on temp dirs; fake only the cordis `Context` edge |
| Adapters | `tests/git.test.ts`, `run.test.ts`, `paths.test.ts`, `truncate.test.ts` | real fs/child-process against temp dirs |
| Infra edges | `tests/http.test.ts` | mocked `http` types, no server |
| Client pure logic | `tests/client/*` | pure function tests (derive, parse, store, format) |
| Layering itself | `tests/architecture.test.ts` | the import-graph rules |

Conventions:

- Host test files live at `tests/` root (legacy layout — don't add new
  subdirs there); client tests mirror the face in `tests/client/`.
- Fake at the **port boundary** (`nodeServiceDeps()` + a stub `Context`);
  don't mock internals you can construct for real.
- `pnpm selfcheck` runs the plugin end-to-end against a scratch profile —
  use it after touching the composition root or tool schemas.

## Change recipes

- **New tool**: schema + delegation in `infra/tools.ts`; the operation body in
  `app/` (one file); result shapes through `contracts.ts`; add a toolview in
  `features/dashboard/toolviews.tsx` if it renders.
- **New driven capability**: port interface in `app/ports.ts` → adapter in
  `adapters/` → entry in `adapters/index.ts` → consume via `this.deps`.
- **New client UI area**: new slice under `features/`; reuse `entities/` +
  `shared/` — never import `features/dashboard/` from another slice.
- **New derived snapshot field**: add to `wire.ts` → compute in
  `app/experiment-service.ts` `snapshot()` → derive display in
  `entities/derive.ts` → render in the feature.
- **New wire field**: type in `wire.ts`, `import type` on both faces, update
  producer + consumers in one commit.

## Accepted seams & debt ledger

Deliberate exceptions — documented, minimal, and listed so they don't spread:

1. **Framework types in `app/`** (`Context`, `Agent` via `import type`):
   full inversion (an app-owned `Sessions` port) is deferred; the type-only
   import keeps the app testable with a stub Context.
2. **`node:path` / `process.cwd()` in `app/`**: path math is pure; `cwd()`
   reads the session env. If either grows beyond paths, inject a port.
3. **JSONL state rebuild in `adapters/jsonl.ts`**: the fold over log entries
   is mechanical and fully covered by tests; promote to `domain/` if it ever
   grows policy (validations, migrations).
4. **Tests layout**: host tests at `tests/` root predate the standard;
  `tests/client/` is the pattern going forward.
