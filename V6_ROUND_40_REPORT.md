# Chickenbots V6 — round 40 report

**Scope:** navigation overhaul and the reach defects it exposed in excavation,
building and base building. Everything below was executed in this checkout; live
Minecraft behaviour is explicitly marked **UNVERIFIED** where it could not be
exercised here.

## 30. Round 40 acceptance ledger (A–L)

### A. Navigation is a shared library, not per-bot ad-hoc walks

`src/navigation/` now contains nine modules:

| module | responsibility |
| --- | --- |
| `blocks.js` | block classification, passability, doors/passables with zero collision height |
| `standability.js` | feet/head/support verdicts, `resolveStandable`, `standableCandidates`, bounded drops |
| `planner.js` | bounded A* with start recovery, segmenting, `closest`/`closestDistance` reporting |
| `arbiter.js` | one motion owner at a time with priority and cancellation tokens |
| `telemetry.js` | attempts, success rate, p50/p95/max plan duration, last error, structured events |
| `stuck.js` | unconditional displacement sampling (v1's displacement gate hid frozen bots) |
| `recovery.js` | bounded recovery goals plus human-readable recovery reasons |
| `congestion.js` | fleet-wide stance claims, TTLs, operator moves never relocated |
| `manager.js` | validation → arbitration → execution → stuck/recovery → arrival verification → telemetry |

`MockBot` and `RealBot` both expose `navigation`, `navigationStatus()` and
`summary().navigation`. The pathfinder call is injected, so one policy serves
simulation and the live adapter.

### B. Validation and refusal codes are honest

`NavigationManager` refuses with explicit codes:

`INVALID_DESTINATION`, `DESTINATION_UNLOADED`, `NO_STANDABLE_DESTINATION`,
`MOVEMENT_BUSY`, `DEAD`, `NO_EXECUTOR`.

Arrival is verified against the resolved goal, not the raw requested block Y.
A pathfinder success that leaves the bot outside the requested range returns
`ARRIVAL_UNVERIFIED` instead of a false success.

### C. Configuration and validators

`config.navigation` now covers strict destinations, max drop, water, attempt
counts, recovery delay, stuck window, world-wait, default timeout, congestion
radius/TTL, long-distance segmenting, planning node limits and the
pathfinder griefing controls (no dig, no scaffold, no door opening by default).
`npm run validate` checks the numeric ranges.

### D. Operator route commands

`goto` remains the movement command. Round 40 adds a non-moving planning command:

```text
path <x> <y> <z> [bot]     # plan a route, report steps/distance/expanded/ms
path [bot]                 # navigation state: owner, attempts, success rate,
                           # stuck samples, plan latency, congestion
```

`path` resolves the destination with `goalPosition` (so a map block Y is lifted
to a standable destination), then calls the bounded planner. It never moves the
bot and returns the first 200 waypoints.

### E. Dashboard navigation surface

The bot profile “Navigation” tab now renders the real navigation snapshot:
moving owner/priority, attempts, success rate, last error, stuck samples/events,
plan p50/p95, congestion peers, plus a `path <name>` button. Browser assets use
relative URLs only; `deploy:check` verifies that.

### F. Fleet congestion is wired once per runtime

`src/runtime.js` owns a single `FleetCongestion` and every bot receives it via
`setNavigationFleet` during `_syncBots`. Claims are advisory and TTL-bounded;
operator/emergency moves report conflicts but are never relocated. This is the
fleet-wide form of the “ten bots choose the same stance” failure.

### G. Excavation reach and access-route defects

Four concrete defects were found and fixed with world instrumentation:

1. **Stair floors were being deleted.** The old access route cleared three
   blocks per step including the floor, so the worker ended in a shaft with
   `no path … upward`. The route now uses feet coordinates, preserves each
   floor, starts at the real terrain surface (`surfaceAt`, with `blockAt` scan
   as fallback), and clears feet + head + jump headroom.
2. **The staircase entrance was one block short of the surface.** A fixed
   `max.y + 3` start left a gap on shallow quarry boxes. The start is now
   derived from the terrain surface.
3. **The bottom corridor cut the staircase floors.** Stairs and corridor now
   live on different Z rows (`min.z - 1` vs `min.z`) and join only at the bottom.
   Bottom corridors run under the full footprint; earlier per-region branches
   were removed because they carved the volume being dug and destroyed quarry
   terrace walls.
4. **Deep regions were excavated from the bottom.** A worker cannot see the top
   layer of a six-deep quarry from its floor. Each region now starts on the
   surface above its own box and digs top-down; the staircase remains available
   for descent. `_sweepReachable` relocates off a block before digging it, and
   `_settleToSupport` applies gravity after a floor is removed.

Torches are placed on the floor of a cleared cell, but the centre of the pit
floor is kept clear so the walking line does not read as a non-air block.

### H. Building / base building reach

- `MockBot.buildReach` is 32, matching the mock's temporary-scaffold model for
  roofs. The building engine approaches only when the target is beyond that
  reach.
- Obstacle clearing has a shorter real reach than placing: the engine now steps
  into dig range before `digBlock`, instead of faithfully reporting “too far to
  dig” after a large-reach placement decision.
- Mock workers with no support beside an elevated schematic hover/work at their
  current level instead of failing to plan. Supported miners/farmers never take
  that branch.
- `buildBasePhase` only treats a failed approach as fatal when the cell is
  actually outside placing reach, so terrain furniture cannot wedge a whole base
  phase.

### I. Test evidence (executed, not inferred)

| suite | result |
| --- | --- |
| full `npm test` | **466 / 466 pass**, 0 fail, 147.8 s |
| `excavation-exec.test.js` | 9 / 9 (AT, foundation, quarry terraces) |
| `excavation.test.js` | 25 / 25 |
| `construction.test.js` | 11 / 11 |
| `builder` + `building-engine` + `schematic-safety` | 28 / 28 |
| `autonomy` + `home-storage` + `connection-lifecycle` + `runtime-safety` | 69 / 69 |
| `controllers` | 8 / 8 |
| `farming` | 13 / 13 |
| `mining-teamwork` | 11 / 11 |
| `woodcutting-safety` | 7 / 7 |
| `task-pipeline` | 27 / 27 |
| new `navigation-path.test.js` | 3 / 3 |

The quarry test now completes in under a second of simulated work instead of
stalling at `ACTIVE` for 46 s, and the platform is verified by air blocks rather
than trusting the dig call.

### J. Gates

| gate | result |
| --- | --- |
| `npm run lint` | PASS — 187 files, 0 errors, 5 warnings |
| `npm run validate` | PASS — secret check, lint, command audit, Node, roster, config, deploy checks |
| `npm run commands:audit` | 46/48 executed or help-audited, **0 failures** |
| `npm run deploy:check` | 13/13 |
| `npm run perf:status` | PASS — p50 2 ms, p95 5 ms, max 5 ms (target 50 ms) |
| secret check | PASS — 231 tracked files |

### K. Residual risks / explicitly unverified

- **UNVERIFIED:** live-server navigation acceptance on EmpiSMP. No live
  connection was used in this round; all movement evidence is deterministic
  MockBot/MockWorld.
- **UNVERIFIED:** browser/WebGL rendering of the new dashboard card. The page is
  syntax-checked as an ES module and `deploy:check` confirms relative URLs, but
  no browser automation ran here.
- `npm run buildings:audit` and full schematic-library auditing were not rerun
  as a release artifact.
- Carried defects not addressed here: single-bot `eat|fish|defend|guard|duel`,
  `FARM_CROP` soil loops, `item (1.3m)` death cause, `npm audit` 6 moderate,
  BUG-27-10/11, and `lighting.js` treating `unloaded` as a block name.
- MockBot remains a simulation: its unsupported-worker hover and air-target
  stance shortcut model temporary scaffolding, not real physics. RealBot always
  uses the strict planner.

### L. Files changed

- new: `src/navigation/{blocks,standability,planner,arbiter,telemetry,stuck,recovery,congestion,manager,movements}.js`
- new: `tests/navigation-path.test.js`, `V6_ROUND_40_REPORT.md`
- wiring: `src/bot/mockBot.js`, `src/bot/realBot.js`, `src/config.js`, `src/runtime.js`
- excavation: `src/excavate/planner.js`, `src/excavate/executor.js`
- building/base: `src/building/engine.js`, `src/actions/index.js`
- operator surface: `src/commands/index.js`, `src/dashboard/public/js/pages/fleet.js`
- tests: `tests/command-audit.test.js` (registered command count 48)

**Commit discipline:** changes are committed file-by-file; `git add -A` is not
used.
