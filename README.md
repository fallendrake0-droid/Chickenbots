# Chickenbots V4

Five autonomous Minecraft bots that survive, cooperate, mine, farm, excavate and build a validated
schematic library on a vanilla **Overworld** server. Everything is local, deterministic and
configuration-driven. There is **no AI service, no API key and no cloud inference** anywhere in the
runtime; the optional AI hook exists as a disabled flag.

```
roster (fixed):  ______   101010   010101   110011   001100
server:          cr3xlol.aternos.me:55742   (MC_VERSION=auto, ViaVersion/ViaBackwards friendly)
dashboard:       http://127.0.0.1:3000      (binds 0.0.0.0 for sandbox previews)
```

> Honest scope note: the entire team, survival, excavation, builder, command and dashboard stack is
> exercised by the test suite against a deterministic `MockWorld`/`MockBot` implementation of the
> same adapter contract used by the live `RealBot` (Mineflayer). The live connection path
> (connect → authenticate → spawn gate, pathfinding, digging, placing, containers, combat) is
> implemented but has **not** been validated against the Aternos server from this repository's
> test environment. Treat first live deployment as commissioning, not as a guaranteed outcome.

---

## Quick start

```bash
npm install
cp .env.example .env          # optional; defaults already match the required server
npm start                     # live: connects all five bots
npm start -- --simulate       # deterministic local simulation (no network)
npm run cli -- --simulate     # interactive command shell
npm test                      # full test suite
npm run validate              # lint + tests + full 1120-design validation + consistency
```

Dashboard (live or simulated): <http://127.0.0.1:3000>. In the Arena sandbox the same server is
reachable through the preview proxy because it binds `0.0.0.0:3000`.

Useful scripts:

| script | what it actually does |
| --- | --- |
| `npm start` | creates the runtime, connects the five bots, starts autonomy + dashboard |
| `npm start -- --simulate` | boots the deterministic mock world and the full dashboard |
| `npm run cli -- --simulate "status"` | runs one command through the shared validated handler |
| `npm test` | all layer tests (team, excavation, schematics, builder, survival, controllers) |
| `npm run lint` | syntax check + project-specific safety rules + ESLint |
| `npm run validate` | lint, tests, full library regeneration/validation and consistency checks |
| `npm run schematics:generate` | regenerates `data/schematics/manifest.json` from the seeded generator |
| `npm run schematics:validate` | regenerates every design, verifies hashes, materials, phases, support |
| `npm run schematics:stats` | prints tier/category/material statistics |

---

## Architecture

```
src/
  config.js                 frozen roster + all configuration (env-overridable)
  runtime.js                team runtime: shared state, bots, autonomy loop, connection gate
  runtimeState.js           one coherent state snapshot for dashboard/CLI
  logger.js                 levelled logger with sinks
  bot/
    adapter.js              the single interface every controller uses
    realBot.js              Mineflayer adapter (login/spawn gate, pathfinder, containers, smelting)
    mockWorld.js            deterministic voxel world: terrain, caves, ores, oak trees, lake, lava, hut, mobs
    mockBot.js              deterministic adapter implementing the same contract
  team/
    comms.js teamMemory.js allocation.js taskBoard.js resourceLedger.js leadership.js
    formations.js emergencies.js plans.js teamCoordinator.js
  excavate/
    safety.js footprint.js mask.js regions.js planner.js verifier.js executor.js manager.js
  schematics/
    blockGrid.js palettes.js primitives.js designHash.js generator.js library.js format.js validate.js
  builder/builder.js        cooperative phased construction with real material transfers
  actions/                  survival, combat, mining, woodcutting, farming, sleep, exploration, inventory, home base
  commands/                 registry.js (validation/confirmation) + index.js (all commands)
  dashboard/                Express API + 16-tab single-page dashboard
scripts/                    lint, validation, schematic generation/statistics
tests/                      team, excavation, schematics, builder, survival, controllers, autonomy
```

### Teamwork (not a chat wrapper)

* Shared memory with attributable observations (reporter, timestamp, position, dimension,
  confidence, expiry). Consumers re-verify before acting.
* Objective manager and task board with dependencies, claims with TTL, heartbeats, retries,
  cancellation, spatial region reservations and lock deadlock detection/resolution.
* Resource ledger with per-bot inventories, verified storage counts, reservations and real
  transfer requests. The builder moves items between bots and containers instead of duplicating them.
* Internal comms bus (objective created, task completed, emergency, leader elected, transfers).
* Emergency response: low health, lava, drowning, fall, mob swarm, outmatched retreat; never the
  victim, max two responders, never strips the last defenders.
* Leadership election with deterministic fallbacks and formation/spacing slots.

### Survival, PvE and the world

* Eat before starving, prioritise healing, wear armour, craft replacement tools, shield up when hurt.
* Lava/fire clutches (water bucket), fall clutches, flee when outmatched, respawn handling.
* PvP is **disabled by default**. Teammates and ordinary players are never valid auto-targets;
  only hostile mobs are attacked automatically. PvE attacks are guarded in both adapters.
* Mining scans for every Overworld ore, enforces pickaxe tiers, refuses lava-adjacent digs,
  liquid ceilings and unsupported floors, lights tunnels, records ore discoveries.
* Woodcutting chops trunks top-down, clears attached leaves, collects saplings and replants on the
  original soil. Farming harvests crops, replants seeds, and feeds animals where the adapter supports it.
* Sleep reserves a bed through the shared task board (TTL lock) so two bots cannot claim one bed.

### Excavation

Preview → explicit confirmation → start. Supported plan types: `BOX`, `AT` (lower corner),
`RADIUS`, `QUARRY` (terraces), `TRENCH`, `FLATTEN`, `FOUNDATION` (from a schematic). The manager
splits the mask into non-overlapping regions for the team, assigns regions, verifies completion
block-by-block via `ExcavationVerifier`, supports pause/resume/stop/undo-preview/assign/team, and
reassigns regions when a bot disconnects.

Safety is enforced on real block data: bedrock/barriers/command blocks never dug; containers, beds,
farms, redstone and functional blocks require explicit authorisation and are preserved by default;
ores preserved unless a deliberate mining operation removes them; liquids are never opened blindly.
The access staircase/corridor is carved under a team lock before digging.

### Builder

`SchematicBuilder` turns a validated schematic into phased, spatially separated tasks
(foundation → floors → walls → stairs → roof → towers → interior → decoration → lighting → terrain),
checks protected blocks and missing materials **before** starting, distributes material requirements,
clears only natural obstacles, places real blocks through the adapter, transfers missing materials
from teammates/containers, and only calls `taskBoard.complete(..., {verified: true})` after rescanning
the world and finding every block in place. `npm run schematics:validate` and the test suite both
exercise real placement and failure paths.

### Schematic library

* **1120 designs** (minimum required 1100), all unique, generated from deterministic seeds.
* Tiers/difficulty: Beginner 1–100, Novice 101–200, Apprentice 201–350, Intermediate 351–500,
  Advanced 501–650, Expert 651–800, Master 801–950, Grandmaster 951–1120.
* 78 categories across 8 structural archetypes (house, fortress, temple, modern, infrastructure,
  garden, underground, fantasy) and 12+ material styles.
* 8,626,743 blocks total, 7,702 average, 78,900 largest; footprint caps 400 per axis / 80,000 blocks.
* Identity is a material-class, rotation/mirror-invariant `geometryHash`; palette-only recolours keep
  the same geometry hash and are rejected by `specHash`. Both are checked across the entire library.
* Every design has a palette validated against `minecraft-data` 1.21.4, phases, foundation/supports,
  material totals, dimension bounds and support analysis.
* Import/export: Sponge **`.schem` v2** (gzip NBT, tested round-trip) and legacy MCEdit
  **`.schematic`** (best effort with explicit substitution report). Imports are restricted to the
  `schematics/` directory. Rotation/mirroring/material substitution helpers are tested.

Regenerate and inspect:

```bash
npm run schematics:generate
npm run schematics:validate
npm run schematics:stats
```

---

## Configuration

All values can be set in `.env` or the environment. Defaults matter and are preserved.

| variable | default | meaning |
| --- | --- | --- |
| `MC_HOST` | `cr3xlol.aternos.me` | server address |
| `MC_PORT` | `55742` | server port |
| `MC_VERSION` | `auto` | protocol negotiation; Aternos ViaVersion handles the rest |
| `MC_AUTH` | `offline` | `offline` or `microsoft` |
| `MC_REGISTER_PASSWORD` / `MC_LOGIN_PASSWORD` | *(empty)* | optional AuthMe-style register/login after spawn |
| `MC_SIMULATE` | `false` | run the deterministic simulator |
| `DASHBOARD_PORT` | `3000` | dashboard port |
| `DASHBOARD_HOST` | `0.0.0.0` | bind address (sandbox preview needs this) |
| `AUTONOMY_ENABLED` | `true` | autonomy request; still gated on connection+auth+spawn |
| `PvP_ENABLED` | `false` | PvP stays off unless explicitly enabled |
| `EXCAVATE_MAX_BLOCKS` | `250000` | refusal limit for a single excavation |
| `AI_PROVIDER`, `AI_ENDPOINT`, `AI_API_KEY` | *(empty)* | unused; AI hook disabled |

The five usernames are frozen in `src/config.js`. `RealBot` throws if asked to construct any other
name, and the runtime always builds exactly the same five bots.

---

## Commands

One validated `CommandRegistry` serves the dashboard, CLI, terminal and internal calls. Chat is
output-only: dangerous or confirmation-gated commands are refused from `source: 'chat'`. Command
lines are tokenised with quote support; shell metacharacters (`; | & $ < > \``, backslash, newlines,
`../`) are rejected before dispatch. Numeric arguments are bounded and every destructive command
requires an explicit `confirm` token or `confirmed:true`.

```
help [command]                 status                         diagnostics
ai [status|off]                team [state|memory|locks|tasks|roles|leader|formation]
bot <name|all> <status|goto x y z|come|eat|where>
inventory [bot]                eat [bot]                       sleep [bot]
mine [bot] [ore]               chop [bot]                      farm [bot]
defend [bot]                   explore [bot] [steps]
task <list|add|assign|info|cancel|retry> ...
excavate preview <box|at|radius|quarry|trench|flatten|foundation> ...
excavate start [previewId] confirm [authorized] [team]
excavate status|pause|resume|stop|undo-preview|assign|team ...
build <designId|number|query> [x y z] [run] confirm
build status|list|run|stop ...
home set x y z | home status | home build [tier]
schematics <list|search|info|stats|validate|export|import> ...
pause | resume | stop
```

Examples:

```bash
node src/cli.js --simulate "schematics info 0001_beginner_shelter"
node src/cli.js --simulate "excavate preview quarry 100 64 100 10 10 6"
node src/cli.js --simulate "excavate status"
node src/cli.js --simulate "build 0001_beginner_shelter 60 72 60 confirm run"
```

---

## Dashboard

Sixteen tabs, server-rendered shell + live state feed (SSE with polling fallback), relative URLs only:

`OVERVIEW · TEAM CONTROL · SURVIVAL · COMBAT · INVENTORY · MINING · EXCAVATION · WOODCUTTING ·
FARMING · SLEEP · EXPLORATION · BUILDER · SCHEMATICS · HOME BASE · TASK MANAGER · DIAGNOSTICS`

The command console posts to `/api/command` and uses the same registry (dashboard source). Schematic
downloads are served as `.schem` from `/api/schematics/:id/download.schem`. `/api/state` exposes the
snapshot used by the UI and by external monitoring.

---

## Testing and validation

```bash
npm test                       # every test file
npm run test:team              # coordination, memory, ledger, locks, emergencies
npm run test:excavation        # planning + execution against mock bots
npm run test:schematics        # generator, hashes, .schem/.schematic round-trips, builder
npm run test:survival          # survival, combat, mining, woodcutting, farming, sleep, inventory, runtime/autonomy
npm run validate               # lint + tests + full library validation + consistency
```

The suite asserts real behaviour, not just return codes: blocks disappear from the mock world, ores
drop items, saplings are replanted, crops are harvested and reseeded, builds are rescanned, tasks are
only completed with `verified: true`, and destructive commands without confirmation fail.

Known environment constraints: `npm run schematics:validate` regenerates all 1120 designs and takes
roughly two minutes; the full validation pass is therefore not part of the default `npm test`.

## Limitations / next commissioning step

* Live server behaviour depends on the actual Aternos plugins, ViewDistance, pathfinding and
  latency; the runtime surfaces connection errors and refuses autonomy until all five bots are ready.
* Building large designs (tens of thousands of blocks) is intentionally gated by material checks and
  real placement; a Grandmaster design is a multi-session project, not instant.
* The optional AI hook is not implemented. Deterministic local intelligence is the only mode.

## License

MIT.
