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
dashboard:       http://127.0.0.1:3000      (loopback by default; preview opts into 0.0.0.0)
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
npm run validate              # secret scan + lint + tests + full 1120-design validation + consistency
```

Dashboard (live or simulated): <http://127.0.0.1:3000>. The default bind is loopback because the
dashboard can issue commands. For the Arena sandbox preview (which proxies a non-loopback port), start
it explicitly with `--allow-insecure` (or set `DASHBOARD_ALLOW_INSECURE=true`) and preferably a token:

```bash
node src/index.js --simulate --host 0.0.0.0 --port 3000 --allow-insecure
# or: DASHBOARD_TOKEN=<16+ chars> node src/index.js --simulate --host 0.0.0.0 --port 3000
```

Useful scripts:

| script | what it actually does |
| --- | --- |
| `npm start` | creates the runtime, connects the five bots, starts autonomy + dashboard |
| `npm start -- --simulate` | boots the deterministic mock world and the full dashboard |
| `npm run cli -- --simulate "status"` | runs one command through the shared validated handler |
| `npm test` | all layer tests (team, excavation, construction, schematics, builder, survival, combat, controllers) |
| `npm run lint` | syntax check + project-specific safety rules + ESLint |
| `npm run validate` | secret scan, lint, tests, full library regeneration/validation and consistency checks |
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
  dashboard/                Express API + modular operations console (38 routed pages)
scripts/                    lint, validation, schematic generation/statistics
tests/                      team, excavation, construction, schematics, builder, survival, controllers, autonomy
```

### Teamwork (not a chat wrapper)

* Shared memory with attributable observations (reporter, timestamp, position, dimension,
  confidence, expiry). Consumers re-verify before acting.
* Tasks created from the dashboard or CLI enter the same board, receive a unique timestamped ID,
  are claimed by exactly one bot, heartbeated while an action runs, and are reconciled every
  coordinator tick. A cancelled, completed or expired task cannot leave a bot permanently assigned
  to dead work; a task with no verified progress for `TASK_STALL_MS` is released for re-planning.
  Completion still requires a verified world change.
* Objective manager and task board with dependencies, claims with TTL, heartbeats, retries,
  cancellation, spatial region reservations and lock deadlock detection/resolution. Autonomous
  planning never disables itself permanently: a completed objective is followed by a fresh plan,
  a failed one backs off exponentially (60s, 120s, … capped at 5 minutes) and the dashboard exposes
  `team.planning` so "no objective" is visible instead of guessed at.
* Tasks record the command that created them, the operator, `createdAt` and `lastProgressAt`, so an
  operator can trace a row back to their own request rather than trusting a label.
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
* PvE is **enabled by default** (`PVE_ENABLED=true`): hostile mobs are attacked automatically.
* PvP is **enabled as a feature by default** (`PvP_ENABLED=true`), but it is not autonomous player
  aggression. Teammates and ordinary players are never valid auto-targets; a player must be named by
  an operator (`target add`, `duel`, or an authorised arena), and the policy still refuses teammates,
  protected players, unauthorised names and servers with `SERVER_PVP_ENABLED=false`. No packet
  exploits, reach hacks or fabricated hits are used.
* Death diagnostics record the real position, last attacker/death message (with an explicit
  `confirmed`/`likely`/`unknown` confidence instead of pretending to know an unobserved cause),
  health/food/velocity at death, nearby threats, the task the bot was working on, held/offhand/armour
  equipment and a bounded scan of the feet/head/floor blocks (`lava`, `fire`, `water`, `suffocation`,
  `falling`). A rolling death-loop detector (`3 deaths/2 min` or `5/10 min`) puts the bot into a
  recovery state: it stops claiming work, heals/equips, retreats toward home, releases its task for
  re-planning and only resumes after a quiet safe-hold period. An unsafe spawn (hostiles within
  range, critical health or hunger) starts the same recovery instead of feeding the loop.
* Mining scans for every Overworld ore, enforces pickaxe tiers, refuses lava-adjacent digs,
  liquid ceilings and unsupported floors, lights tunnels, records ore discoveries.
* Woodcutting chops trunks top-down, clears attached leaves, collects saplings and replants on the
  original soil. Farming reads vanilla crop ages, harvests only mature crops, harvests pumpkin/melon
  fruit without breaking the stem, replants and verifies each block, tills soil with a real hoe,
  builds a hydrated plot when needed, and feeds/breeds animals with a verified food deduction.
* Inventory fullness uses real storage slots (36, stack-aware, and the live
  window slots when Mineflayer exposes them), never a count of distinct item names. When a mining,
  chopping, farming or excavation run fills a bot, it walks to the team's spawn-anchored home,
  crafts two chests from planks/logs if needed, places and verifies a double chest, deposits every
  non-tool/non-gear/non-food/non-light stack, then returns to the same work site and resumes the same
  board assignment. The chest is registered in the resource ledger as 54-slot `home overflow` storage;
  build phases withdraw their materials back out instead of failing with an empty inventory.
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
| `MC_JOIN_INTERVAL_MS` / `MC_JOIN_JITTER_MS` | `10000` / `0` | minimum gap between login sockets. Paper's `connection-throttle` is per source IP, so five bots on one host must join slowly or the server rejects them. |
| `MC_CONNECT_STAGGER_MS` / `MC_CONNECT_JITTER_MS` | `10000` / `0` | exact gap before queuing each bot's initial connection task; the join queue also enforces `MC_JOIN_INTERVAL_MS` |
| `MC_THROTTLE_DELAY_MS` / `MC_THROTTLE_MAX_DELAY_MS` | `90000` / `600000` | fleet-wide pause after a throttle or a socket that never reaches spawn. One outage episode records **one** strike no matter how many bots fail in it; a genuinely separate outage (after a bot became ready) escalates the bounded, jittered pause up to the maximum |
| `MC_REGISTER_PASSWORD` / `MC_LOGIN_PASSWORD` | *(empty)* | AuthMe-style login after spawn; bots stay frozen and unready until confirmed. No credential is built in: a live connecting run refuses to start until these are set in `.env` or the environment. Login-only by default. Set `MC_AUTH_ENABLED=false` to disable. |
| `MC_AUTH_REGISTER_ON_FIRST_JOIN` | `false` | Opt in to sending `/register` once before `/login` (only needed for a brand-new account) |
| `MC_AUTH_ENABLED` | `true` | Set to `false` for servers with no password plugin |
| `MC_AUTH_DELAY_MS` / `MC_AUTH_TIMEOUT_MS` | `300` / `12000` | settle delay and confirmation timeout for password auth |
| `MC_RECONNECT_JITTER_MS` | `4000` | jitter added to reconnect attempts so five bots do not retry together |
| `MC_DNS_TIMEOUT_MS` | `10000` | DNS preflight budget, timed separately from TCP and reported as its own stage |
| `MC_CONNECT_TIMEOUT_MS` | `45000` | TCP connect stage timeout, measured from the socket attempt |
| `MC_VIEW_DISTANCE` | `tiny` | client-requested chunk radius: `tiny` (6), `short` (8), `normal` (10), `far` (12), or 2–32. The live fleet still stalled for 40s at `short`; `tiny` is the safe default. Lower it to 2–5 on a slow host |
| `MC_INBOUND_YIELD` | `true` | pause the inbound socket between kernel reads so a chunk burst cannot monopolise one event-loop turn |
| `MC_LOGIN_TIMEOUT_MS` | `30000` | handshake/login stage timeout; separate from configuration, spawn and AuthMe so failures are diagnosable |
| `MC_CONFIGURATION_TIMEOUT_MS` | `15000` | configuration-exchange budget once the server sends `start_configuration` |
| `MC_SPAWN_TIMEOUT_MS` | `45000` | spawn stage timeout |
| `MC_KEEPALIVE_MS` | `120000` | client-side watchdog threshold. The library still sends the reply itself; this is a diagnostic, not the reconnect strategy |
| `MC_STALE_AFTER_MS` | `90000` | a connected bot with no inbound packet for this long is reported as `No packets`, never `Online` |
| `MC_REJOIN_DELAY_MS` | `10000` | hold-down before the first rejoin after a real session ends; the fleet reconnect supervisor keeps trying and the throttle queue backs off if the server rejects it |
| `MC_SIMULATE` | `false` | run the deterministic simulator |
| `DASHBOARD_PORT` | `3000` | dashboard port |
| `DASHBOARD_HOST` | `127.0.0.1` | bind address; loopback by default because the dashboard can issue commands |
| `DASHBOARD_LOCAL` | `false` | force `127.0.0.1` regardless of `DASHBOARD_HOST` |
| `DASHBOARD_ALLOW_INSECURE` | `false` | explicitly allow an unauthenticated non-loopback bind (trusted preview only; the CLI flag is `--allow-insecure`) |
| `DASHBOARD_TOKEN` | *(empty)* | optional 16+ character control-plane password (HTTP Basic password or Bearer token); set it before exposing the dashboard beyond loopback |
| `LOG_LEVEL` | `info` | `info` prints lifecycle and errors; `debug` adds lifecycle detail |
| `MC_TRACE_PACKETS` | `false` | opt-in per-packet movement/keepalive tracing. Leave off during normal live runs: a flooded terminal can block the event loop and drop the socket |
| `AUTONOMY_ENABLED` | `true` | autonomy request; still gated on connection+auth+spawn |
| `TASK_STALL_MS` | `45000` | a task with no verified progress this long is released for re-planning; real excavation work (a dug shaft/branch) resets the timer even before the quota moves |
| `TASK_STALL_CYCLES` | `3` | minimum no-progress action cycles before release |
| `PVE_ENABLED` | `true` | autonomous hostile-mob defence; on by default |
| `PvP_ENABLED` | `true` | PvP feature enabled by default, but players are only attacked when explicitly authorised on the target list |
| `SERVER_PVP_ENABLED` | `true` | set `false` when the Minecraft server itself has `pvp=false`; all PvP is then refused |
| `EXCAVATE_MAX_BLOCKS` | `250000` | refusal limit for a single excavation |
| `AI_PROVIDER`, `AI_ENDPOINT`, `AI_API_KEY` | *(empty)* | unused; AI hook disabled |

**Credential note.** Earlier revisions of this repository contained a literal demo password in
`src/config.js`, `.env.example` and this README. It has been removed from the current tree; no value is
reproduced here. Treat that historical value as compromised, rotate the Minecraft/AuthMe password for
the five accounts, and keep the new value only in an untracked `.env`. `npm run check:secrets` fails if
a credential-shaped value or the old demo value is committed again.

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
bot <name|all> <status|where|goto x y z|come|follow|return|eat|mine [ore]|chop [type]|farm [plant [crop] [count]|maintain|status|crop]|fish [n]|defend|combat|guard [x y z]|duel <player>|explore [n]|sleep>
inventory [bot]                eat [bot]                       sleep [bot|all|auto on|off]
survival [bot|all] [eat|healing|armour|tools|crafting|shield] [on|off]
auto <eat|healing|armour|tools|crafting|shield|weapon|totem|potions|food> [on|off] [bot|all]
mine [bot] [ore|stone|stop]     chop [bot] [species|stop]       farm [bot] [plant [crop] [count]|maintain|status|crop|animals|stop]
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
task <list|add TYPE [label] [--params JSON|key=value...]|assign|priority|info|cancel|retry|objective> ...
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
queue status | queue retry <bot|all> | queue cooldown reset
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
node src/cli.js --simulate 'task add MINE_BLOCK iron --params {"block":"iron_ore","limit":8}'
node src/cli.js --simulate "task add STORE_ITEMS deposit item=bread count=8"
node src/cli.js --simulate "task list"
```

---

## Dashboard

A modular operations console served from `src/dashboard/public/` with 38 routed pages, grouped so
that related tasks sit together rather than in one long tab strip:

* **Overview** – fleet summary, live vitals chart, activity feed and objectives.
* **Live World** – a bounded 3D view rendered from real block data (`/api/world`): exposed surface
  heightfield, chunk accounting, live bots/entities, orbit/zoom/pan, click-to-select and follow,
  FPS/frame/triangle/draw-call instrumentation and a 2D fallback when WebGL is unavailable.
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
are served as `.schem` from `/api/schematics/:id/download.schem`. The world viewer fetches
`/api/world?bot=<name>&radius=4..32&height=8..64`; the server scans one surfaced block per column and
returns a compact palette plus real bots/entities, so caves and interiors are not invented or
transmitted. Responses are clamped, limited to 65x65 columns and 80 entities, cached for 1.5 s, and
carry their own generation time and scan duration. A missing bot/position returns `NO_BOT` or
`NO_POSITION` instead of placeholder terrain.

Connection state is computed once on the server (`src/bot/status.js`) and attached to every bot as
`online`, `status` and `statusLabel`; the overview, fleet, team and diagnostics views render that
verdict instead of re-deriving it. A bot is only `Online` when its socket is open, it has
authenticated and spawned, it is alive, and it received a packet within `MC_STALE_AFTER_MS`. Other
states (`Joining`, `Authenticating`, `Auth failed`, `Dead`, `No packets`, `Offline`) are shown
explicitly. `/api/state` always builds a fresh snapshot and the SSE feed publishes once per second,
so a kicked bot cannot remain green on screen.

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
npm run validate               # secret scan + lint + tests + full library validation + consistency
```

The suite asserts real behaviour, not just return codes: blocks disappear from the mock world, ores
drop items, saplings are replanted, crops are harvested and reseeded, builds are rescanned, tasks are
only completed with `verified: true`, and destructive commands without confirmation fail.

Known environment constraints: `npm run schematics:validate` regenerates all 1120 designs and takes
roughly two minutes; the full validation pass is therefore not part of the default `npm test`.


## Building system: exact placement, custom schematics and honest limits

The builder stack is a deterministic blueprint engine, not a block-approximation
generator. A palette entry may carry full state (`oak_stairs[facing=east,half=top]`),
and every placed block is read back from the world and compared by name **and**
properties before it can become `VERIFIED`.

- **Engine** (`src/building/engine.js`) — dependency-ordered plan (supports, door
  halves, bed halves, gravity blocks), world-confirmed placement, `verify`,
  `repair`, `tripleCheck` and an extra-block audit. A placement call that returns
  without throwing is never trusted; unknown/unloaded chunks are reported as
  `unloaded`, never as air.
- **Block states** (`src/building/blockStates.js`) — parsing, formatting,
  placement-item mapping, 90° rotation and axis mirroring. Rotation preserves a
  stair's `shape`; mirroring flips `hinge`/`shape` as Minecraft does.
- **Registry** (`src/building/blockRegistry.js`) — `minecraft-data`-backed block
  and item lookup with per-property value validation. `26.3` is reported as
  `NEAREST_KNOWN` (the installed data tops out at 26.1); the fallback is explicit
  in every report and never presented as exact 26.3 data.
- **Schematic I/O** (`src/building/schematicIO.js`) — Sponge `.schem` (v1–v3),
  Litematica `.litematic`, vanilla structure `.nbt`, legacy `.schematic` and
  native JSON. Packed states, negative regions and block entities are preserved
  where the format exposes them; unsupported payloads are reported.
- **Custom catalogue** (`src/building/customLibrary.js`) — drop files in
  `data/schematics/custom/` or upload from the dashboard. Imports are lazy,
  content/geometry deduplicated, indexed with licence and source metadata, and
  removable without re-importing on the next scan. Importing and building are
  separate operations.
- **Dashboard** — **Builder Operations → Building Workspace** wires import,
  rescan, per-build pause/resume/stop/verify/repair, per-block evidence and
  exports to the real endpoints. The full library page remains the browse/search
  surface.

### Verified library size (honest)

`data/schematics/manifest.json` contains **1,120 unique generated designs**
(1,120 unique geometry hashes, 8,688,787 blocks). Each of the 1,120 blueprints
was reconstructed and audited through `BuildEngine.validateBlueprint()` and its
dependency planner: **0 invalid blocks, 0 support/dependency cycles, 0 failures**.
The configured long-term target remains 10,000; the project has **not** reached
that target and the runtime reports the real count (base + custom) at all times.

```bash
npm run buildings:audit                 # full blueprint audit (≈8–9 minutes)
npm run buildings:audit -- --limit 50   # quick sample
node scripts/buildings-audit.js --json report.json
```

Structural validation does not prove functional redstone logic, farm output or
live-server behaviour. Those require separate live functional tests and are not
claimed here.

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
  Bots join **one socket at a time**, at least `MC_JOIN_INTERVAL_MS` (10s by default) apart, because
  Paper's `connection-throttle` is enforced per source IP and all five bots share the host's IP.
  A throttle or a socket that never reaches spawn pauses **every** join. All failures in the same
  outage are one strike, so four bots timing out do not turn a 90s pause into 10 minutes; a bot that
  becomes ready closes the episode and clears the pause, and only a separate later outage escalates
  the bounded, jittered backoff. Only one live runtime may run per checkout: a PID lock
  (`data/runtime/live.pid`) refuses a second instance, because duplicate logins make Aternos close the
  first socket as an uninformative `EPIPE`/`ECONNRESET`. If you control the server, set
  `settings.connection-throttle: 0` in `bukkit.yml` (or a value below `MC_JOIN_INTERVAL_MS`) and restart
  it; otherwise keep the interval generous. A bot that drops re-enters the same queue after
  `MC_REJOIN_DELAY_MS` (10s by default), and the reconnect supervisor keeps running even while
  autonomy is paused. Connected bots send a real swing animation every 30s so a writable session is
  visible to idle plugins. Chickenbots does **not** fabricate movement or jump to defeat AFK checks; the
  real 20 tps client tick loop is the fix for a client that looks frozen.
  When `MC_LOGIN_PASSWORD` is set (there is no built-in default; put it in an untracked `.env`),
  every join sends only `/login` because the accounts already exist. If the server answers `You are not registered.`, Chickenbots
  creates that account once (`/register`) and retries `/login`. Set
  `MC_AUTH_REGISTER_ON_FIRST_JOIN=true` to register before the first login attempt instead. Movement is frozen and autonomy stays gated until the
  server confirms authentication in chat; all position/look/flying packets are held so Paper or AuthMe
  cannot kick the bot for moving before login. A failed or unconfirmed password disconnects the bot
  instead of letting it move. An operator/staff kick or a ban pauses automatic retries for that bot;
  reconnect explicitly from the dashboard after reviewing the reason. Generic network/protocol kicks
  still use bounded, jittered backoff, and the runtime never deliberately spams reconnects. Bans and
  whitelist/operator kicks still pause retries: automatically evading moderation would turn a
  temporary kick into a ban. All other drops are retried indefinitely by default.
  Minecraft 1.21.2+ / 26.x needs the vanilla client tick loop: exactly one `client_tick_end` at the
  end of every client tick, after that tick's movement packet. Mineflayer 4.39.0 predates the upstream
  fix, so Chickenbots runs its own 20 tps scheduler, handles `set_ticking_state` / `step_tick`, and
  defers a second position-bearing packet to the next tick. It never sends a duplicate tick_end after
  a movement packet, and it does not send `player_loaded` itself because Mineflayer already does. If
  protocol kicks continue, set `MC_VERSION` to the server's exact version instead of `auto`.
  The client-requested view distance also matters: Mineflayer's default `far` asks the server for
  up to 625 chunks per bot. `minecraft-protocol` 1.68.0 decompresses each compressed frame with
  synchronous `zlib.unzipSync` inside its stream transform, so a five-bot chunk burst can freeze
  timers for tens of seconds, miss the server's 30s keep-alive deadline and surface as `EPIPE`
  right after the block clears. Chickenbots now replaces that transform with an async `zlib.unzip`
  step as the library is loaded, so decompression no longer holds the event loop. Bots also request
  `MC_VIEW_DISTANCE=tiny` (6) by default and the inbound socket yields between kernel reads
  (`MC_INBOUND_YIELD=true`) as defence in depth. The 17:25 live run blocked for 40s at `short` before
  this patch, so keep 2–5 on a slow host and only raise the distance when the dashboard's live
  event-loop delay shows the host can absorb the chunk burst. The Connections page reports
  mean/p99/max delay from `monitorEventLoopDelay`. The pre-teardown snapshot also records the last
  inbound/outbound packet name, pending socket bytes and the last valid state, and
  `/api/diagnostics/export` downloads a redacted state + log bundle for support.
  With `MC_VERSION=auto`, Chickenbots validates the server status ping once before opening any login
  socket. A sleeping/starting Aternos instance commonly reports protocol `-1`; the runtime waits for a
  real version instead of sending five bots into mineflayer's autoVersion crash path. While the probe
  is unresolved the reconnect supervisor does not start login sockets, so a sleeping server is not
  charged as five bot connection attempts or retry backoff.
  The resolved version must be listed in `minecraft-protocol`'s supported-version set. If a proxy
  advertises a newer status name than the protocol it answered with, the protocol mapping wins.
  `LOG_LEVEL=debug` (opt-in; the default is `info`) adds lifecycle detail and auth timing. Per-packet
  movement, keepalive and position traces stay off even then unless `MC_TRACE_PACKETS=true`: writing
  that volume to a terminal can block the event loop and cost the socket its keepalive. A kicked bot
  gets a pre-cleanup disconnect snapshot with the session generation, stage, timings, keep-alive and
  tick-loop counters, plus a bounded lifecycle timeline. A server respawn packet that arrives without
  a preceding death is recorded as `respawn_ignored`; the following spawn is a duplicate, not a
  `respawned` line. The Connections dashboard renders the same
  timeline as per-bot cards. Passwords are
  never printed; auth commands, echoed `/register`/`/login` chat, configured secret values and
  password/token-shaped metadata are redacted centrally before they reach the terminal, log store or
  dashboard. The dashboard binds loopback by default. A non-loopback bind without
  `DASHBOARD_TOKEN` is refused unless `DASHBOARD_ALLOW_INSECURE=true` / `--allow-insecure` explicitly
  opts in for a trusted preview; same-origin, rate-limit, CSP and no-store protections apply in every
  mode.
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
