# Chickenbots V6

Five autonomous Minecraft bots that survive, prepare a real site, run materials and warehouse
logistics, light and secure the ground, then build a validated schematic on a vanilla **Overworld**
server. V6 adds a complete five-bot combat engine — PvE threat profiles, explicit-only PvP,
weapon/armour evaluation, offhand totems, consumables, team roles, focus fire, rescue and retreat —
on top of the V5 construction crew and the existing survival, excavation and builder stack. Everything
is local, deterministic and configuration-driven. There is **no AI service, no API key and no cloud inference** anywhere in the
runtime; the optional AI hook exists as a disabled flag.

```
roster (fixed):  ________   10101000   01010100   11001100   00110000
server:          cr3xlol.aternos.me:55742   (MC_VERSION=auto, ViaVersion/ViaBackwards friendly)
dashboard:       http://127.0.0.1:3000      (binds 0.0.0.0 for sandbox previews)
```

> Honest scope note: the entire team, survival, excavation, construction, builder, command and dashboard stack is
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
| `npm test` | all layer tests (team, excavation, construction, schematics, builder, survival, combat, controllers) |
| `npm run lint` | syntax check + project-specific safety rules + ESLint |
| `npm run validate` | lint, tests, full library regeneration/validation and consistency checks |
| `npm run deploy:check -- --url http://127.0.0.1:3000` | read-only commissioning check: config, V5/V6 surfaces, browser URLs, live health/state/commands |
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
  construction/
    constants.js            19 pipeline phases, 16 build milestones, statuses, schematic rotation
    siteSurvey.js           observed-block survey, hazard detection, candidate scoring, overlap refusal
    sitePreparer.js         clearance, excavation, cut/fill levelling, drainage, perimeter
    lighting.js             block-light emission tables, spawnable surfaces, plan/execute/audit
    materials.js            real BOM, availability, deficits, acquisition, safe substitution, reservations
    storage.js              Warehouse: labelled chests, capacity, verified deposit/retrieve, locks
    pipeline.js             phase engine from ANALYSIS to CLEANUP, operator confirmation wrappers
    manager.js              project lifecycle, persistence, selection, autonomy, reporting
  combat/
    constants.js            combat states, action priority, damage/speed/reach, armour and effect tables
    mobs.js                 33+ hostile/neutral profiles, explosive/undead/arthropod/aquatic traits, avoid list
    equipment.js            weapon scoring, target-specific enchants, armour optimisation, durability
    supplies.js             food choice, potion identification, golden apples, consumption
    totems.js               offhand equip/verify, activation evidence, replacement and team ledger
    players.js              explicit PvP authorisation, teammates, protection, arena and server rules
    team.js                 five roles, shared focus, formation offsets, rescue, retreat, regroup
  builder/builder.js        cooperative phased construction with real material transfers
  actions/                  survival, combat, mining, woodcutting, farming, fishing, sleep, exploration, inventory, home base
  commands/                 registry.js (validation/confirmation) + index.js (all commands)
  dashboard/                Express API + modular operations console (37 routed pages)
scripts/                    lint, validation, schematic generation/statistics
tests/                      team, excavation, construction, schematics, builder, survival, controllers, autonomy
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
  victim, max two responders, never strips the last defenders. The combat coordinator adds explicit
  focus fire, role-based offsets, rescue assignment and a whole-team retreat.
* Leadership election with deterministic fallbacks and formation/spacing slots.

### Survival, PvE and the world

* Eat before starving, prioritise healing, wear armour, craft replacement tools, shield up when hurt.
* Lava/fire clutches (water bucket), fall clutches, flee when outmatched, respawn handling.
* PvP is **disabled by default**. Teammates and ordinary players are never valid auto-targets;
  only hostile mobs are attacked automatically. PvP requires an explicit target list, can be limited
  to an arena, and still refuses teammates, protected players, unauthorised names and servers with
  PvP disabled. No packet exploits, reach hacks or fabricated hits are used.
* Mining scans for every Overworld ore, enforces pickaxe tiers, refuses lava-adjacent digs,
  liquid ceilings and unsupported floors, lights tunnels, records ore discoveries.
* Woodcutting chops trunks top-down, clears attached leaves, collects saplings and replants on the
  original soil. Farming harvests crops, replants seeds, and feeds animals where the adapter supports it.
* Sleep reserves a bed through the shared task board (TTL lock) so two bots cannot claim one bed.

### Combat engine (V6)

The combat controller is one coordinator per bot plus a team coordinator over all five. Every value it
reports is read from the adapter or the real inventory — no guessed mob health, no invented totem
pops, no hidden aim assist.

* **PvE profiles.** `src/combat/mobs.js` classifies 43 registry names and applies traits: undead
  (Smite), arthropod (Bane of Arthropods), aquatic, explosive (creeper/charged creeper), ranged
  (skeleton/stray/pillager/blaze/ghast), flying, armoured, boss and avoid (`warden`,
  `elder_guardian`, `wither`). Neutral animals are not targets; spiders are hostile.
* **Weapon choice.** Swords, axes, tridents, maces, bows and crossbows are scored from base damage,
  attack speed, enchantments, durability and the actual target. Sharpness, Smite, Bane, Fire Aspect,
  Knockback, Looting, Power, Piercing, Quick Charge, Multishot, Density, Breach, Wind Burst and Mending
  affect the score. Axes gain value against a blocking player; broken or nearly broken items are
  replaced from the inventory. Maces are scored as situational fall attacks, not free damage.
  On the live adapter, `gear layout` moves combat items into stable hotbar slots and refuses to
  displace another protected combat item; the simulator reports the conceptual slot plan instead.
* **Armour.** Every slot is evaluated with armoured points, toughness, Protection/Projectile/Blast/
  Fire/Feather Falling, durability and Elytra preference. The controller equips the best real pieces.
* **Totems.** A totem is equipped in the offhand, verified from the adapter, and only counted as
  activated when the adapter emits a real activation event or the inventory count drops in the same
  damage window. Replacements come from the inventory; the team ledger reports who holds what.
* **Supplies.** Food is chosen by hunger/saturation and emergency health; golden apples and enchanted
  golden apples are reserved for critical moments; potions are identified by real item names
  (`potion_of_healing`, splash/lingering variants) and only consumed when their effect helps.
* **Shield and dodge.** Shield block and strafe/dodge are attempted only when the adapter exposes the
  operation; failures are reported, not hidden. Axe selection is preferred when the observed target is
  blocking and an axe is actually carried.
* **Aim and criticals.** The live adapter aims at the observed entity, leads moving targets for arrows
  and bolts from their measured velocity, and attempts a jump critical only when grounded, close,
  non-explosive and not already sprinting. The server remains authoritative; a refused or cancelled
  hit is not counted as damage.
* **Team fight.** `TeamCombatCoordinator` assigns COORDINATOR, FRONTLINE, FLANKER, RANGED and SUPPORT
  from real loadouts, picks one shared focus target, spaces the bots with role offsets, assigns a
  non-victim rescuer, hands a spare golden apple to the most injured teammate, and supports
  DEFENSIVE, GUARD, FOLLOW, ARENA, ESCORT and RETREAT modes. `follow <bot|player>` moves the team
  behind a leader at a safe distance and never authorises PvP by itself. Death clears the stale target
  and releases that bot's target locks before respawn recovery.
* **Action priority.** Dead → totem emergency → critical heal → teammate rescue → retreat → dodge →
  eat → potion → shield → attack → reposition → loot → recover. Higher-priority safety always wins.

Commands (all real state):

```
combat [status|on|off|start|stop|mode <TEAM_FIGHT|DEFENSIVE|GUARD|FOLLOW|ARENA|BOSS|ESCORT|RETREAT>|guard x y z|duel <player>|rescue|heal]
pve [on|off|status]            pvp [on|off|status]         target [add|remove|protect|unprotect|clear|list] <player>
follow <bot|player> [distance] | follow stop
gear [status|optimise|durability|progression|layout] [bot]         totem [status|reserve [n]|refill]
food [status] [bot]            potions [status] [bot]        guard x y z [bot] | guard stop
duel <player> confirm          arena on [radius] | arena off
auto <armour|weapon|totem|food|potions|shield|heal> [on|off] [bot|all]
team combat [status|on|off|defend|retreat|regroup|rescue|heal|attack <player>]
bot <name> combat|guard [x y z]|duel <player> confirm
```

> **Validation note.** The automated suite and the local live preview run against the deterministic
> simulator. They verify controller decisions, physical inventory changes, command wiring and reported
> statistics; they do not claim real-server PvP wins. On a live server the server and anti-cheat remain
> authoritative, damage is only counted when an observed health drop is returned, and refused or
> unverifiable hits are reported rather than invented.

The dashboard adds a **Combat Operations** group with Combat Overview, Team Fight, Equipment,
Totems & Supplies and PvP & Targets. Cards show each bot's real health, food, weapon damage,
armour score, offhand, totem count, supplies, role, target and recent combat events. Combat Overview
carries per-policy automation switches for weapon, armour, shield, totem, food, potions and emergency
healing. Team Fight carries a real follow form and a stop-following control. The PvP target form writes
the same explicit list as the CLI, and the PvP-off control is always visible.

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

### Construction operations (V5)

`ConstructionManager` owns persisted projects and runs one active project at a time through 19
observable phases: analysis, survey, site selection, clearance, excavation, levelling, drainage,
lighting, perimeter, temporary storage, material calculation, gathering, warehouse storage, build
plan, construction, interior, security audit, quality verification and cleanup. Every phase has a
status, attempt count and detail payload; a phase that cannot be completed becomes `BLOCKED` with a
reason instead of retrying forever. `runPhase` refuses to re-run a `COMPLETE` phase unless an operator
explicitly forces it.

* **Survey** reads observed blocks only. Unloaded chunks are reported as `unloaded` and counted as
  `stats.unknown`; they are never treated as air. The survey refuses to select a site while any
  observable column is unknown, scores candidates by flatness, hazards, space, access, excavation
  and observed resources, and rejects footprints that overlap another project.
* **Site preparation** previews clearance before any block is broken, protects structures and ores,
  excavates and levels with cut/fill, drains standing liquids, places real light blocks on observed
  spawnable surfaces, fences the perimeter with a gate, and stages materials in a labelled chest.
  Reserved bill-of-materials stock is never consumed by fences, chests or lighting.
* **Materials** computes a BOM from the validated schematic palette, compares it with live bot
  inventories plus verified warehouse stock, lists deficits and acquisition options, applies only
  safe same-role substitutions, and can reserve stock against accidental spending.
* **Warehouse** labels and categorises chests, scans real contents, verifies deposits and withdrawals,
  tracks capacity/categories and honours locks. Deposits and withdrawals re-read the container instead
  of trusting the adapter's return value.
* **Quality and security** re-read the placed world block by block, compare palette and dimensions,
  audit block light and hostile observations, and only then complete the project. Lighting does not
  stop spawners, raids, patrols or special mob rules, and the UI says so.

The dashboard surfaces this as a **Builder Operations** group: Builder Overview, Builder Projects,
Site Survey, Site Preparation, Lighting, Material Planning, Storage, Team Assignments and QA &
Security. All world-changing controls are confirmation-gated.

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
| `MC_VERSION_PROBE_TIMEOUT_MS` | `8000` | validated status-ping timeout before opening login sockets |
| `MC_SERVER_START_DELAY_MS` | `30000` | wait between probes while Aternos reports offline/starting (`protocol -1`) |
| `MC_VERSION_RETRY_MS` | `60000` | wait before retrying an unsupported or invalid explicit version |
| `MC_AUTH` | `offline` | `offline` or `microsoft` |
| `MC_CONNECT_STAGGER_MS` / `MC_CONNECT_JITTER_MS` | `5000` / `1000` | gap between joining bots; the runtime serializes logins and pauses all joins after an Aternos throttle |
| `MC_THROTTLE_DELAY_MS` | `30000` | minimum retry delay after a throttled join |
| `MC_REGISTER_PASSWORD` / `MC_LOGIN_PASSWORD` | `chickenbot12345` | AuthMe-style register/login after spawn; bots stay frozen and unready until confirmed. Set `MC_AUTH_ENABLED=false` to disable. |
| `MC_AUTH_ENABLED` | `true` | Set to `false` for servers with no password plugin |
| `MC_AUTH_DELAY_MS` / `MC_AUTH_TIMEOUT_MS` | `300` / `12000` | settle delay and confirmation timeout for password auth |
| `MC_RECONNECT_JITTER_MS` | `4000` | jitter added to reconnect attempts so five bots do not retry together |
| `MC_SIMULATE` | `false` | run the deterministic simulator |
| `DASHBOARD_PORT` | `3000` | dashboard port |
| `DASHBOARD_HOST` | `0.0.0.0` | bind address (sandbox preview needs this) |
| `LOG_LEVEL` | `debug` | `debug` prints movement/auth/lifecycle traces; use `info` for quiet runs |
| `AUTONOMY_ENABLED` | `true` | autonomy request; still gated on connection+auth+spawn |
| `PvP_ENABLED` | `false` | PvP stays off unless explicitly enabled |
| `SERVER_PVP_ENABLED` | `true` | set `false` when the Minecraft server itself has `pvp=false`; all PvP is then refused |
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
ai [status|off]                team [state|on|off|memory|locks|tasks|roles|leader|formation|resources|objectives|follow|regroup|retreat|defend|reassign]
bot <name|all> <status|where|goto x y z|come|follow|return|eat|mine [ore]|chop [type]|farm [crop]|fish [n]|defend|combat|guard [x y z]|duel <player>|explore [n]|sleep>
inventory [bot]                eat [bot]                       sleep [bot|all|auto on|off]
survival [bot|all] [eat|healing|armour|tools|crafting|shield] [on|off]
auto <eat|healing|armour|tools|crafting|shield|weapon|totem|potions|food> [on|off] [bot|all]
mine [bot] [ore|stone|stop]     chop [bot] [species|stop]       farm [bot] [crop|animals|stop]
fish [bot|all] [casts]          fish stop [bot|all]
defend [bot|stop]              explore [bot] [steps] | explore stop [bot|all]
combat [status|on|off|start|stop|mode|guard|duel|rescue]   pve [on|off|status]   pvp [on|off|status]
target [add|remove|protect|unprotect|clear|list] <player>                   arena on [radius]|off
follow <bot|player> [distance] | follow stop
gear [status|optimise|durability|progression|layout] [bot]    totem [status|reserve [n]|refill]   food|potions [status] [bot]
guard x y z [bot] | guard stop             duel <player> confirm
team combat [status|on|off|retreat|regroup|rescue|heal|attack <player>]
find <village|mineshaft|temple|ruin|forest|cave|diamonds|emeralds|iron|...> [bot]
return home [bot|all]
task <list|add|assign|priority|info|cancel|retry|objective> ...
excavate preview <box|at|radius|quarry|trench|flatten|foundation> ...
excavate start [previewId] confirm [authorized] [team]
excavate status|pause|resume|stop|undo-preview|assign|team ...
builder [projects|create <schematic> [x y z] [rotation]|select <id>|status|report|phases|preview|advance [n] confirm|run [n] confirm|auto on|off|pause|resume|stop]
site [status|survey|candidates|select <id> confirm|boundaries|preview [clear|light]|clear confirm|excavate confirm|flatten confirm|drain confirm|light confirm|secure confirm|audit]
materials [status|calculate|missing|readiness|gather confirm|reserve|locate <item>|deposit|retrieve|transport]
storage [status|scan [bot]|containers|capacity|locate|deposit/retrieve ... confirm|organise]
build select <designId|number|query> | build preview [designId]
build start [run] confirm | build pause|resume|stop|run|status|list ...
build plan|phase|phases|progress|assign|verify|repair confirm|finish confirm|projects
build <designId|number|query> [x y z] [run] confirm
home set x y z | home status | home build [tier] [run] confirm
schematics <list|search|info|stats|validate|export|import> ...
pause | resume | stop
```

Examples:

```bash
node src/cli.js --simulate "schematics info 0001_beginner_shelter"
node src/cli.js --simulate "excavate preview quarry 100 64 100 10 10 6"
node src/cli.js --simulate "excavate status"
node src/cli.js --simulate "build 0001_beginner_shelter 60 72 60 confirm run"
node src/cli.js --simulate "builder create 0001 24 64 24"
node src/cli.js --simulate "site survey"
node src/cli.js --simulate "site preview clear"
node src/cli.js --simulate "materials readiness"
node src/cli.js --simulate "build select 0001_beginner_shelter"
node src/cli.js --simulate "build preview"
node src/cli.js --simulate "home set 10 64 -10"
node src/cli.js --simulate "fish all 1"
node src/cli.js --simulate "combat status"
node src/cli.js --simulate "pve on"
node src/cli.js --simulate "gear status 10101000"
node src/cli.js --simulate "totem status"
node src/cli.js --simulate "target add FriendlyRival"
node src/cli.js --simulate "follow 10101000 4"
node src/cli.js --simulate "gear progression 10101000"
node src/cli.js --simulate "team combat heal"
node src/cli.js --simulate "team combat retreat"
```

---

## Dashboard

A modular operations console served from `src/dashboard/public/` with 37 routed pages, grouped so
that related tasks sit together rather than in one long tab strip:

* **Overview** – fleet summary, live vitals chart, activity feed and objectives.
* **Activity** – live activity, notifications and logs.
* **Fleet** – all bots, team board, profiles and connection management.
* **Gameplay** – survival, inventory, mining, excavation, woodcutting, farming, fishing,
  exploration and sleep.
* **Combat Operations** – combat overview and live engagement log, team roles/focus/retreat,
  per-bot equipment and durability, totem/supply ledger, explicit PvP targets, protection list and
  arena configuration.
* **Builder Operations** – builder overview and pipeline, builder projects, site survey, site
  preparation, lighting, material planning, warehouse/storage, team assignments, QA & security.
* **Legacy construction** – home base, builder, schematic library (filters, pagination, isometric
  preview), build projects and project history.
* **System** – task manager, logs/diagnostics and settings.

The shell is loaded per route (`js/app.js` + `js/router.js`) and hydrated from `/api/state`, `/api/logs`,
`/api/commands`, `/api/settings` and `/api/schematics`. A single SSE feed (`/api/events`) drives live
updates; same-route updates morph the existing DOM instead of rebuilding the page, preserving focus,
form values and open chart state. All URLs are relative, icons are inline SVG (no CDN), and the UI
works without external network access. Command buttons post to `/api/command` and use the same
registry as the CLI, including explicit confirmation for destructive operations. Schematic downloads
are served as `.schem` from `/api/schematics/:id/download.schem`.

Design system: `css/tokens.css` (colour, type, spacing), `css/layout.css` (shell and grids),
`css/components.css` (buttons, cards, tables, modals), `css/pages.css` (page-specific composition) and
`css/responsive.css`. Reduced-motion and compact-density preferences are honoured, focus states are
visible, and tables are labelled. The dashboard exposes only what the backend actually reports:
inventory slot positions, for example, are not in the adapter contract, so the UI shows real item
totals plus armour/offhand pieces rather than inventing a hotbar layout.

Keyboard and pointer affordances: `/` (outside a form field) or `Ctrl/Cmd K` opens the command
palette, `Esc` closes the active overlay, and the sidebar has a labelled collapse/expand control whose
choice persists. Every command button and form reports success or the backend's own error text through
a toast; successful commands refresh state in the background so switches and counters reflect the
confirmed result without a full page reload. Motion comes from short opacity/translate transitions only
and is disabled by the reduced-motion preference.

---

## Testing and validation

```bash
npm test                       # every test file
npm run test:team              # coordination, memory, ledger, locks, emergencies
npm run test:excavation        # planning + execution against mock bots
npm run test:schematics        # generator, hashes, .schem/.schematic round-trips, builder
npm run test:survival          # survival, combat, mining, woodcutting, farming, sleep, inventory, runtime/autonomy
npm run test:combat            # weapons, armour, totems, supplies, mobs, PvP policy, controller, team
npm run test:features          # fishing, structure clues, sleep automation, build pause/resume, command surface
npm run test:construction      # survey hazards, BOM, warehouse, pipeline, rotation, command families
npm run validate               # lint + tests + full library validation + consistency
```

The suite asserts real behaviour, not just return codes: blocks disappear from the mock world, ores
drop items, saplings are replanted, crops are harvested and reseeded, builds are rescanned, tasks are
only completed with `verified: true`, and destructive commands without confirmation fail.

Known environment constraints: `npm run schematics:validate` regenerates all 1120 designs and takes
roughly two minutes; the full validation pass is therefore not part of the default `npm test`.

## Deployment check

```bash
npm run deploy:check                                        # static checks only
npm run deploy:check -- --url http://127.0.0.1:3000        # static + live dashboard probe
```

The check verifies the frozen roster, safe server/PvP/AI defaults, the eight V6 combat modules and
eleven combat command families, the five Combat Operations routes, the eight V5 construction modules,
the nine Builder Operations routes, relative-only browser URLs and V6 package metadata. With `--url`
it also probes `/healthz`, `/api/state` (including five combat controllers), `/api/commands` and the
dashboard shell, so a broken preview or a missing combat/construction snapshot fails before
commissioning.

## Limitations / next commissioning step

* Live server behaviour depends on the actual Aternos plugins, ViewDistance, pathfinding and
  latency; the runtime surfaces connection errors and refuses autonomy until all five bots are ready.
  Bots join one at a time with jitter, and throttled joins use a 30-second floor before retrying.
  When `MC_LOGIN_PASSWORD` or `MC_REGISTER_PASSWORD` is set (the default is `chickenbot12345`), the first
  join sends `/register` and later reconnects use `/login`. Movement is frozen and autonomy stays gated
  until the server confirms authentication in chat; all position/look/flying packets are held so Paper or
  AuthMe cannot kick the bot for moving during registration. A failed or unconfirmed password disconnects
  the bot instead of letting it move.
  A server-side `Invalid move player packet` kick usually means the protocol version does not match;
  set `MC_VERSION` to the server's exact version instead of `auto`.
  With `MC_VERSION=auto`, Chickenbots validates the server status ping once before opening any login
  socket. A sleeping/starting Aternos instance commonly reports protocol `-1`; the runtime waits for a
  real version instead of sending five bots into mineflayer's autoVersion crash path.
  The resolved version must be listed in `minecraft-protocol`'s supported-version set. If a proxy
  advertises a newer status name than the protocol it answered with, the protocol mapping wins.
  `LOG_LEVEL=debug` (the default) prints each outgoing movement packet, each server position packet,
  auth timing, spawn/respawn events, and a 40-event trace dump when a bot is kicked. Passwords are
  never printed; auth commands and echoed `/register`/`/login` chat are redacted.
* Building large designs (tens of thousands of blocks) is intentionally gated by material checks and
  real placement; a Grandmaster design is a multi-session project, not instant.
* The construction pipeline is validated against `MockWorld`. Live operation still depends on the
  server's view distance, chunk loading, latency and container/pathfinding behaviour; a survey that
  cannot observe a column blocks selection by design.
* Lighting covers observed spawnable surfaces only. It does not claim to stop spawners, raids,
  patrols or special mob rules.
* Combat is validated against `MockWorld`. Live reach, knockback, shield timing, projectile charge
  and totem activation depend on the server's latency and plugins; the controller refuses actions the
  adapter cannot confirm rather than claiming a hit or a totem save. PvP remains off unless an
  operator explicitly authorises a named player and the server itself allows PvP.
* The optional AI hook is not implemented. Deterministic local intelligence is the only mode.

## License

MIT.
