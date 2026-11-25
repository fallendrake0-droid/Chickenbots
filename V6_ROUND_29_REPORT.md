# Chickenbots V6 — round 29 report (large hardening pass)

**Branch:** `arena/de11bd2d-chickenbots`
**Starting commit:** `62f1650`
**Implementation commit:** this round's commit
**Push:** `origin/arena/de11bd2d-chickenbots`

> **Evidence boundary:** no Minecraft server is reachable from this sandbox.
> Nothing here is a live acceptance claim. `FIXED (unit)` means the code path was
> exercised by the Node test suite or deterministic simulation in this checkout.

## A. Repository and gate

| Item | Value |
|---|---|
| Repository | `fallendrake0-droid/Chickenbots` |
| Branch | `arena/de11bd2d-chickenbots` |
| Starting head | `62f1650` |
| Server target | `EmpiSMP.aternos.me:32990` |
| Test result | **370 / 370 pass**, 0 fail, 46.1 s |
| Lint | **PASSED**, 158 files |
| Consistency | **PASSED (10/10)** |
| Deploy check | **12/12** |
| Secret leak check | **PASSED**, 190 tracked files |
| Schematic catalogue | 10,001 designs, manifest unchanged |

This pass did not disable features, lower quotas, skip tests, or add fake
success. The only new limits are explicit, documented caps on untrusted input
and hostile geometry; normal designs have large headroom.

## B. What was reviewed

Server-side runtime and command surfaces, schematic import/validation, the task
board and resource ledger, dashboard snapshot/world viewer, log store, protocol
decompression, construction pipeline/lifecycle/materials/storage, excavation
planner/regions/executor/verifier/footprint, builder state machine, combat
equipment/mobs/players/supplies/team/totems, and the main action controllers
(combat, woodcutting, exploration, common block scanning).

## C. Bugs found and fixed

| ID | Sev | Area | Root cause and failure mode | Fix | Regression test |
|---|---|---|---|---|---|
| BUG-29-01 | P0 | Schematic import | Importers accepted arbitrary input and inflated data with no bound; a huge or malformed file could exhaust memory | Added `src/schematics/limits.js` (64 MB input/inflated, 2 M blocks, 4 M volume, 4096 dimension, 65 536 palette) and enforced it in import | `schematic-safety.test.js` |
| BUG-29-02 | P0 | Gzip import | A gzip bomb could inflate without a cap | `safeGunzip` uses `maxOutputLength`; `ERR_BUFFER_TOO_LARGE` becomes a clean error | `schematic-safety.test.js` |
| BUG-29-03 | P0 | Sponge import | `BlockData` length was trusted, so a short/oversized array indexed out of bounds | Length/stride validation before decoding | `schematic-safety.test.js` |
| BUG-29-04 | P0 | Async decompression | The asynchronous decompressor dropped the length check used by the sync path | Both paths share the same cap and reject oversized output | `protocol-compression.test.js` |
| BUG-29-05 | P1 | Task board locks | An expired reentrant lock stayed alive because `reentrant > 1` skipped expiry; heartbeats renewed only the synthetic task lock | Expiry is authoritative; heartbeat renews task/owned locks and regions | `team.test.js` |
| BUG-29-06 | P1 | World viewer | Malformed entity/teammate coordinates produced `NaN`/`Infinity` and crashed the snapshot | Coordinates are validated and malformed entities skipped | `world-view.test.js` |
| BUG-29-07 | P2 | Command history | `logStore.recent(badSince)` compared against an invalid timestamp | `since` is parsed/validated; invalid values fall back cleanly | `log-store.test.js` |
| BUG-29-08 | P1 | Command parameters | `--params` JSON could set `__proto__`/prototype keys | Prototype-polluting keys are rejected before merge | `command-params.test.js` |
| BUG-29-09 | P1 | Home command | `setHome` accepted `NaN`/out-of-world coordinates | Finite, in-world coordinates required | `runtime-home.test.js` |
| BUG-29-10 | P1 | Dashboard download | A crafted schematic filename could inject `Content-Disposition` headers | Filename sanitised and quoted | `dashboard-filenames.test.js` |
| BUG-29-11 | P1 | Custom library | Custom schematic reads had no size bound | Same input cap as the main importer | `schematic-safety.test.js` |
| BUG-29-12 | P1 | Resource ledger | `commit` could exceed a reservation and then release it, under-reporting stock | Commit clamps to `remaining`, reports `excess`, keeps accounting consistent | `team.test.js` |
| BUG-29-13 | P1 | Plan quotas | `splitQuota` crashed or produced absurd arrays for 0/NaN/negative `parts` | Parts clamped to 1…1000, quota clamped to a non-negative integer | `team.test.js` |
| BUG-29-14 | P1 | Site survey | `SiteSurveyor.survey` returned `Infinity`/`NaN` statistics for invalid footprints | Rejects non-finite/non-positive dimensions and zero sample limits | `construction.test.js` |
| BUG-29-15 | P1 | Woodcutting | `chopTree` threw on an unloaded block and counted failed digs as harvested | Null block is a clean error; only verified digs count | `woodcutting-safety.test.js` |
| BUG-29-16 | P1 | Schematic validation | Malformed/missing `knownBlocks` made validation throw | Defensive defaults for `knownBlocks` and dimension checks | `schematic-safety.test.js`, `schematics.test.js` |
| BUG-29-17 | P1 | Imported geometry | Non-finite imported block coordinates entered the schematic | Coordinates are filtered/validated | `schematic-safety.test.js` |
| BUG-29-18 | P1 | Sponge import | Truncated `BlockData` produced a silent 0-block schematic | Truncation is rejected explicitly | `schematic-safety.test.js` |
| BUG-29-19 | P1 | Excavation regions | A tiny box could be “split” into two identical overlapping regions, double-counting volume | `splitRegions` stops when the longer axis is 1 block | `excavation.test.js` |
| BUG-29-20 | P1 | Excavation regions | An empty worker roster produced `{bot: undefined}` assignments | Empty pool returns a structured error and zero assignments | `excavation.test.js` |
| BUG-29-21 | P2 | Excavation executor | `progressEvery` 0/NaN disabled progress heartbeats (`% NaN`) | Coerced to a positive integer at construction | `excavation-exec.test.js` |
| BUG-29-22 | P1 | Excavation executor | `resume()`/`stop()` could flip a stopped executor back to running | Terminal token state is respected; stopped stays stopped | `excavation-exec.test.js` |
| BUG-29-23 | P1 | Excavation manager | `pause/resume/stop` accepted terminal excavations and could reopen them | Status preconditions; terminal calls return `ok:false` and a summary | `excavation-exec.test.js` |
| BUG-29-24 | P1 | Builder/construction lifecycle | `builder.pause()` only set a boolean, leaving `state='RUNNING'`, so resume could never fire and cancel was reversible; completed projects accepted pause/cancel | Real `PAUSED` state, start/resume guards, and terminal project guards | `v4-features.test.js`, `construction.test.js` |
| BUG-29-25 | P1 | Task board transitions | A late `fail()` or `cancel()` could resurrect a completed/cancelled/failed task | Terminal tasks reject further transitions; repeated complete is idempotent | `team.test.js` |
| BUG-29-26 | P1 | Task board claims | `claim/start/heartbeat` could restart or renew a terminal task | Terminal status is rejected by all three | `team.test.js` |
| BUG-29-27 | P2 | Task progress | `updateProgress` accepted `NaN`/`Infinity`, poisoning objective progress | Non-finite values return `null` and leave the task unchanged | `team.test.js` |
| BUG-29-28 | P2 | Builder chunking | `chunkSize` 0/NaN disabled flushing, creating one giant task and a `Math.min(...spread)` RangeError | Finite chunk size, default 96, minimum 8 | `v4-features.test.js` |
| BUG-29-29 | P1 | Dashboard snapshot | One throwing builder/library/excavation/combat status blanked the whole snapshot | Each subsystem degrades to an error row; dashboard remains readable | `dashboard-status.test.js` |
| BUG-29-30 | P2 | Library statistics | An empty manifest produced `Infinity` min/max and `NaN` average | Zeroed statistics for an empty catalogue | `schematics.test.js` |
| BUG-29-31 | P1 | Construction materials | A partial reservation stayed held forever when one item was short | Reservation is all-or-nothing and releases prior holds on failure | `construction.test.js` |
| BUG-29-32 | P0 | Excavation verification | A sampled scan could claim `complete`; blocked access and missing protected ores did not block completion; removed ratio was miscomputed | Sampled runs are `provisionalComplete` only; access/ore/dimension checks gate completion | `excavation.test.js` |
| BUG-29-33 | P0 | Excavation planner | A huge radius enumerated billions of circle cells before the volume limit was checked; non-finite geometry was accepted | Geometry validated (≤4096, finite, volume pre-checked) before any enumeration | `excavation.test.js` |
| BUG-29-34 | P2 | Flatten planning | `surfaceAt` returning no finite heights produced a plan with a null target | Explicit error instead of a malformed plan | `excavation.test.js` |
| BUG-29-35 | P1 | Weapon selection | `switchTo` recommended another low-durability weapon rather than a healthy replacement | Only a chosen weapon below 25% durability gets a healthy `switchTo` | `combat.test.js` |
| BUG-29-36 | P1 | Combat status | Dashboard polling committed a focus target, reset hysteresis and inflated threat statistics; a focus without a position crashed planning | Read-only `status()` path; positionless focus returns no offset | `combat.test.js` |
| BUG-29-37 | P1 | Construction phases | `runPhase()` could restart a COMPLETE or CANCELLED project | Terminal projects refuse phase execution | `construction.test.js` |
| BUG-29-38 | P2 | Construction summary | A persisted project missing optional fields crashed `summary()`; zero phases divided by zero | Safe defaults and a complete/100% fallback | `construction.test.js` |
| BUG-29-39 | P1 | Excavation lighting | Torches were placed one block above the newly cleared cell with no support, so they floated or failed | Torch is placed in the cleared cell only when the floor below is solid | `excavation-exec.test.js` |
| BUG-29-40 | P2 | Woodcutting | A navigation failure silently truncated a tree with no error field | Partial chops report `partial` and a concrete error | `woodcutting-safety.test.js` |
| BUG-29-41 | P2 | Plan labels | A degraded `parts` value produced labels like `(1/0)` | Labels use the real generated quota count | `team.test.js` |
| BUG-29-42 | P1 | Block scanning | `findBlocks(null)` threw while evaluating the default centre; unbounded radius/limit could hang a synchronous scan | Null/non-finite centres return `[]`; radius ≤128 and limit ≤2000 | `connection.test.js` |
| BUG-29-43 | P2 | Exploration | A caller-supplied `Infinity` step count created an unbounded navigation loop | Steps clamped to 1…64 | `v4-features.test.js` |

All 43 are **FIXED (unit)** unless stated otherwise. None is live-verified.

## D. Tests added or extended

New files:

- `tests/schematic-safety.test.js` — 8 tests (import caps, gzip bomb, sponge truncation, palette/coordinate validation).
- `tests/log-store.test.js` — 1.
- `tests/command-params.test.js` — 2.
- `tests/runtime-home.test.js` — 2.
- `tests/dashboard-filenames.test.js` — 2.
- `tests/woodcutting-safety.test.js` — 3.

Extended: `tests/combat.test.js` (20), `tests/connection.test.js` (18), `tests/construction.test.js` (11), `tests/dashboard-status.test.js` (6), `tests/excavation-exec.test.js` (9), `tests/excavation.test.js` (25), `tests/protocol-compression.test.js`, `tests/schematics.test.js` (15), `tests/team.test.js` (30), `tests/v4-features.test.js` (7), `tests/world-view.test.js`.

## E. Gate output (this run)

```text
npm test             370 tests, 370 pass, 0 fail, 46.1 s
npm run lint         LINT PASSED (158 files checked)
npm run validate     PASS: consistency (10/10); VALIDATION PASSED
npm run deploy:check 12/12 checks passed
npm run check:secrets SECRET LEAK CHECK PASSED (190 tracked files)
```

`npm audit --omit=dev` remains 6 moderate findings in the single `uuid <11.1.1`
chain; the advertised fix requires a breaking `minecraft-protocol@0.15.0`
upgrade and was deliberately not forced.

## F. Still open (not claimed fixed)

- **BUG-27-09** — `bot all chop oak` still varies 8–10/10 when nearby trees run out. Reported honestly as a partial fleet result.
- **BUG-27-10** — maximum event-loop block (previous evidence: 1,433.4 ms at `MINE_ORE`). No new performance claim.
- **Review notes, no fix applied:**
  - `planner.buildAccessRoute` caps returned `steps` at 1 200 while `stepCount` is unbounded.
  - `building/engine.auditExtras()` skips the entire `y === 0` layer.
  - `building/engine.placeMany()` stops at the first `FAILED`/`REPAIR_REQUIRED`.
  - `construction/lighting.planLighting` can nominate a `torch` source when the inventory is empty (self-flagged).
  - `commands/index.js:1825` maps `builder stop|cancel` to `m.cancel()`; the manager now returns `ok:false` for terminal projects, and commands must surface that error.
- Live-only movement/survival/auth items from round 27 remain **UNVERIFIED LIVE**.

## G. Files changed

Runtime/source: `src/actions/{combat,common,exploration,woodcutting}.js`,
`src/builder/builder.js`, `src/building/{customLibrary,schematicIO}.js`,
`src/combat/{equipment,team}.js`, `src/commands/index.js`,
`src/construction/{manager,materials,siteSurvey}.js`, `src/dashboard/{server,worldView}.js`,
`src/excavate/{executor,footprint,manager,planner,regions,verifier}.js`,
`src/logStore.js`, `src/protocol/asyncDecompress.js`, `src/runtime.js`,
`src/runtimeState.js`, `src/schematics/{format,library,validate}.js`,
`src/team/{plans,resourceLedger,taskBoard}.js`, plus new `src/schematics/limits.js`.

Tests: 7 new files and 11 extended files listed in section D.
