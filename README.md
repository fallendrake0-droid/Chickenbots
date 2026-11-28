# Chickenbots V6

Ten autonomous Minecraft bots that survive, prepare a real site, run materials and warehouse
logistics, light and secure the ground, then build a validated schematic on a vanilla **Overworld**
server. V6 adds a complete five-bot combat engine — PvE threat profiles, explicit-only PvP,
weapon/armour evaluation, offhand totems, consumables, team roles, focus fire, rescue and retreat —
on top of the V5 construction crew and the existing survival, excavation and builder stack. Everything
is local, deterministic and configuration-driven. There is **no AI service, no API key and no cloud inference** anywhere in the
runtime; the optional AI hook exists as a disabled flag.

```
roster (fixed):  ________   10101000   01010100   11001100   00110000
                 11101000   11101010   10001000   11001010   11101001
server:          EmpiSMP.aternos.me:32990   (MC_VERSION=auto, ViaVersion/ViaBackwards friendly)
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
npm run validate              # secret scan + lint + tests + full 10,000-design validation + consistency
```

Dashboard (live or simulated): <http://127.0.0.1:3000>. The default bind is loopback because the
dashboard can issue commands. For the Arena sandbox preview (which proxies a non-loopback port), start
it explicitly with `--allow-insecure` (or set `DASHBOARD_ALLOW_INSECURE=true`) and preferably a token:

```bash
node src/index.js --simulate --host 0.0.0.0 --port 3000 --allow-insecure
# or: DASHBOARD_TOKEN=<16+ chars> node src/index.js --simulate --host 0.0.0.0 --port 3000
```

Stopping a live runtime: the single-instance guard names the existing pid and refuses to start a
duplicate. Stop it by command line or pid:

```bash
pkill -f 'node src/index.js'   # matches the full command line
kill 1730                      # or the pid printed by the guard
```

`pkill index.js` does **not** work: `pkill` matches the process *name* (`node`), not its argv.

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
| `npm run schematics:summary` | regenerates the 3.3 KB startup/status summary without touching the 20 MB manifest |
| `npm run perf:status` | measures the cold/warm dashboard snapshot in the deterministic simulator |

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
  players/
    registry.js             seen-player directory: entity sightings + server player list, no PvP authority
    controller.js           follow, guard, escort, come, greet, give, drop-loot and message controls
  builder/builder.js        cooperative phased construction with real material transfers
  actions/                  survival, combat, mining, woodcutting, farming, fishing, sleep, exploration, inventory, home base
  commands/                 registry.js (validation/confirmation) + index.js (all commands)
  dashboard/                Express API + modular operations console (42 routed pages)
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
  cancellation, spatial region reservations and lock deadlock detection/resolution. A new launch
  starts **idle with an empty board**: the survival planner is opt-in (`team plan on`, the Team
  page's **Start planner** button, or `AUTONOMY_AUTO_PLAN=true`), so no objective or task is invented
  before the operator asks for one. Once armed, planning never disables itself permanently: a
  completed objective is followed by a fresh plan, a failed one backs off exponentially (60s, 120s, …
  capped at 5 minutes) and the dashboard exposes `team.planning` so "no objective" is visible
  instead of guessed at.
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
* Mining scans for every Overworld ore **and block target**, enforces pickaxe tiers, refuses
  lava-adjacent digs, liquid ceilings and unsupported floors, lights tunnels, records ore
  discoveries, and bootstraps the missing tool chain. `mine diamonds` on a bot with no iron pick
  gathers wood/stone, mines iron and coal, smelts three ingots, crafts the iron pick, then mines the
  diamond. The same gate covers `mine stone`, `mine obsidian`, `mine ancient_debris` and every other
  catalogued target; success still means a block was actually removed. When no block is reachable,
  the access shaft is a 1x2 staircase with a kept floor, so the bot can walk back out instead of
  being stranded at the bottom of a 1x1 hole. One action deadline bounds the moves and digs, and
  the run returns the blocks already mined rather than being cancelled by the watchdog.
* Woodcutting chops trunks bottom-up from the nearest reachable layer, tries adjacent stances,
  clears attached leaves, collects saplings and replants on the original soil. Every removal and
  inventory gain is verified rather than inferred. Fleet-wide tree/ore leases mean two bots never
  walk to the same trunk or vein;
  expired leases are released on disconnect. All tree and mining targets are confined to a shared
  **100x100 work zone centred on home** (`WORK_ZONE_SIZE`), so a bot cannot chase a tree out of the
  area and get lost. The bot returns to the zone before scanning and reports `OUTSIDE_WORK_ZONE`
  rather than silently leaving it. Farming reads vanilla crop ages, harvests only mature crops, harvests pumpkin/melon
  fruit without breaking the stem, replants and verifies each block, tills soil with a real hoe,
  builds a hydrated plot when needed, and feeds/breeds animals with a verified food deduction.
  Crop scans use the world index, so a crop one block away is found even under a status time budget;
  the work limit is applied after the maturity filter, so seedlings cannot hide a ripe crop. Idle
  maintenance harvests fully grown crops and replants them even when the task planner is off.
* Inventory fullness uses real storage slots (36, stack-aware, and the live
  window slots when Mineflayer exposes them), never a count of distinct item names. When a mining,
  chopping, farming or excavation run fills a bot, it walks to the team's spawn-anchored home,
  crafts two chests from planks/logs if needed, places and verifies a double chest, deposits every
  non-tool/non-gear/non-food/non-light stack, then returns to the same work site and resumes the same
  board assignment. The chest is registered in the resource ledger as 54-slot `home overflow` storage;
  build phases withdraw their materials back out instead of failing with an empty inventory.
* Sleep reserves a bed through the shared task board (TTL lock) so two bots cannot claim one bed.
  A 16-block indexed bed scan detects both halves as one bed, and a nearby bed is clicked (foot half)
  to set the server-side spawn point. Detection runs in the idle loop and in the daytime tick;
  `sleep spawn [bot|all]` and the **Set spawn** dashboard buttons repair a fleet by hand. The spawn
  point is only reported as set after the server acknowledges `spawn_position`.

### Navigation and pathfinding

Every move — task, recovery, safety or operator command — goes through one navigation manager per bot
and one fleet arbiter. The dashboard's **Fleet → Navigation** page and every bot's Navigation tab read
the same `navigation.policy` and telemetry that the pathfinder uses, so the numbers shown are the
numbers enforced.

* **One motion owner.** Emergency > operator > recovery > task > routine. A lower-priority request is
  refused as `MOVEMENT_BUSY` instead of silently replacing the path that owns the bot. Fleet stance
  claims relocate two task paths that target the same stance; operator/emergency moves report the
  conflict but never yield.
* **Standable destinations.** A coordinate is resolved to feet/head/support with the real block
  reader. A solid block becomes the stance above it, a nearby standable stance is used when the exact
  column is blocked. A destination in an unloaded chunk is **not rejected**: the bot walks a real loaded
  stance toward it, which reveals the next chunk, and repeats until the destination loads. The short
  `NAV_WAIT_FOR_WORLD_MS` wait is only the fallback when the bot is already at the loaded frontier; it
  never invents a stance. Routine travel never digs or scaffolds.
* **Task targets are not stances.** A tree trunk, ore block or air coordinate is resolved to a real
  stance before planning; the mock adapter walks there like the live one. It no longer snaps onto a
  target in the air.
* **Adaptive search budget.** `mineflayer-pathfinder`'s `searchRadius` is a detour budget, not a route
  length. It now scales with the straight-line distance (`1.5 × distance + 16`), with a 64-block floor
  and a 512-block ceiling, so long walks around a base or ravine are not abandoned at the old fixed 64.
* **Stuck detection on a time window.** Samples slide over `NAV_STUCK_WINDOW_MS` (2.5s), not the last
  32 samples. A bot that stops after one small step is flagged about 2.5s after its last real
  movement; sampling starts only after a non-empty `path_update`, so A* thinking is never called stuck.
* **Arrival evidence and recovery.** `goal_reached` is accepted only after a 300ms settle and a real
  distance check. A success reported more than `range + 3` blocks short is an `ARRIVAL_UNVERIFIED`
  failure and triggers one retry even when the caller did not ask for strict verification. Recovery is
  deterministic: restart, a standable stance **around the real target**, a stance near the start, then
  abort. Tasks default to two attempts; operator moves to three.
* **World model, not a height field.** Doors, fence gates and trapdoors are classified from their real
  block state: an unreadable or closed door is a wall, only an actually open door is passable, and an
  operator policy that allows opening doors still does not turn a closed door into air. Water is
  swim-through, lava is a hazard, and a fall is checked through every body cell on its trajectory.
  Unloaded chunks remain unknown (`DESTINATION_UNLOADED`), never air.
* **Route profiles.** `NAV_ROUTE_MODE` selects a safety envelope without changing the rules: SAFE and
  CAUTIOUS refuse deep drops and price water heavily, FAST allows a 4-block drop, TASK is the balanced
  work profile, COMBAT/RETREAT price hazard contact differently, and FOLLOW keeps a bounded following
  distance. The profile name and the measured terrain composition (`walk`, `diagonal`, `stepUp`,
  `drop`, `water`, `doors`, `maxDrop`) are returned by `path` and shown on the Navigation page.
* **Dimension envelopes.** `NAV_DIMENSION` carries the Y range and drop envelope per dimension. The
  Nether/End cap the drop at two blocks and mark lava/void hazards, so a route that is legal in the
  overworld cannot silently become a lava or void death.
* **Fleet corridors and claims.** A stance claim records the route corridor, not just the destination.
  A conflicting task path is relocated or receives a soft corridor cost; operator and emergency
  claims are reported but never moved. Congestion is ephemeral (TTL), so a finished build cannot
  poison tomorrow's route.
* **Deterministic recovery ladder.** A failure is classified (`PATH_NOT_FOUND`, `PATH_PLAN_TIMEOUT`,
  `PATH_STUCK`, `ARRIVAL_UNVERIFIED`, `MOVEMENT_BUSY`, …), failed cells are remembered per bot, and
  recovery walks a fixed ladder: replan, restart, a stance around the real target (skipping known-bad
  cells), a stance near the start, then an honest abort. Tasks get two attempts, operator moves three.
  The dashboard shows the ladder level, remembered cells and the last failure beside the live route.
* **Bounded planning, not a frozen server.** Every deterministic plan shares one deadline
  (`NAV_PLAN_BUDGET_MS`), expands at most `NAV_MAX_NODES`, and yields between segments. Exit scans are
  removed from the A* inner loop, so a five-bot build cannot monopolise the event loop.
* **Simulator honesty.** The mock planner uses the same standability, diagonal corner guard, bounded
  drops, swimming, ladder, door and dimension rules. Its route preview on the Navigation page is a
  real backend plan and does not move the bot. The only direct mock position relocation left is the
  builder fixture for a bot deliberately suspended beside an elevated schematic; it returns
  `fixture: true` and is not reported as a navigation success.

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
  DEFENSIVE, GUARD, FOLLOW, ARENA, ESCORT and RETREAT modes. `follow <bot>` moves the team behind a
  leader; `follow <player>` starts a persistent, verified player watch instead. The watch leads a moving
  player from measured velocity (or the last two sightings), switches to a 500 ms / 3.2 s catch-up pass
  once the gap exceeds distance + 6, keeps closing a fresh last-known position when the entity briefly
  leaves render distance, and reports lead, catch-up and last-move state on the Players page.
  `follow stop` clears both the player watch and combat follow. Following never authorises PvP by
  itself. Death clears the stale target and releases that bot's target locks before respawn recovery.
* **Action priority.** Dead → totem emergency → critical heal → teammate rescue → retreat → dodge →
  eat → potion → shield → attack → reposition → loot → recover. Higher-priority safety always wins.

Commands (all real state):

```
combat [status|on|off|start|stop|mode <TEAM_FIGHT|DEFENSIVE|GUARD|FOLLOW|ARENA|BOSS|ESCORT|RETREAT>|guard x y z|duel <player>|rescue|heal]
pve [on|off|status]            pvp [on|off|status]         target [add|remove|protect|unprotect|clear|list] <player>
follow <player|bot> [distance 2-16] | follow stop
players [list [category]|near [radius]|info <player>|history <player>|events|refresh|follow <player> [bot|all] [distance]|unfollow [player] [bot|all]|guard <player> [bot|all] [radius]|escort <player> [bot|all]|observe <player> [bot|all]|unwatch [player] [bot|all]|come <player> [bot|all]|stop [bot|all]|give <player> <item> [count] [bot|all]|drop <player> [loot|item] [count] [bot|all]|message <player> <text>|greet <player>|note <player> <text>|tag <player> <tag>|untag <player> <tag>|forget <player>|pvp [status|on|off]|mode <EXPLICIT|ARENA|DEFENSIVE>|target [add|remove|list] [player]|protect|trust|unprotect|untrust <player>|arena [list|on [radius] [name]|add <name> <x1 y1 z1 x2 y2 z2>|remove <name>|clear]]
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

* **10,000 designs** (the requested V6 target; the first 1,120 are the original core slice), all
  unique, generated from deterministic seeds. Where a small tier's structural space rejects a
  duplicate, the slot is refilled by a genuinely generated apprentice design — never a rename.
* Tiers/difficulty: Beginner 1–962, Novice 963–3809, Apprentice 3810–6924, Intermediate 6925–8228,
  Advanced 8229–8910, Expert 8911–9415, Master 9416–9742, Grandmaster 9743–10000. Supplemented
  apprentice refills carry number 10001+, so every id/name remains unique.
* 78 categories across 8 structural archetypes (house, fortress, temple, modern, infrastructure,
  garden, underground, fantasy) and 12+ material styles.
* 27,821,660 blocks total, 2,782 average, 79,436 largest; footprint caps 400 per axis / 80,000 blocks.
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
| `MC_HOST` | `EmpiSMP.aternos.me` | server address |
| `MC_PORT` | `32990` | server port |
| `MC_VERSION` | `auto` | protocol negotiation; Aternos ViaVersion handles the rest |
| `MC_VERSION_PROBE_TIMEOUT_MS` | `8000` | validated status-ping timeout before opening login sockets |
| `MC_SERVER_START_DELAY_MS` | `30000` | wait between probes while Aternos reports offline/starting (`protocol -1`) |
| `MC_VERSION_RETRY_MS` | `60000` | wait before retrying an unsupported or invalid explicit version |
| `MC_AUTH` | `offline` | Mineflayer connection auth: `offline` or `microsoft`. This is not plugin authentication. |
| `MC_JOIN_INTERVAL_MS` / `MC_JOIN_JITTER_MS` | `2000` / `750` | positive, jittered gap between login sockets. A five-bot burst is not the default; a real server throttle still opens a bounded fleet-wide pause. |
| `MC_CONNECT_STAGGER_MS` / `MC_CONNECT_JITTER_MS` | `1500` / `750` | gap before queuing each bot's initial connection task |
| `WORK_ZONE_SIZE` | `100` | shared square work area centred on home; woodcutting and mining refuse targets outside it. `WORK_ZONE_ENABLED=false` is an explicit expedition opt-out |
| `WORK_ZONE_MARGIN` | `2` | inset used when returning/relocating inside the zone, so a bot does not stand on the boundary |
| `FLEET_CONCURRENCY` | `4` | maximum bots executing one fleet command at the same time; every bot still gets its own structured result |
| `MC_THROTTLE_DELAY_MS` / `MC_THROTTLE_MAX_DELAY_MS` | `90000` / `600000` | fleet-wide pause after a throttle or a socket that never reaches spawn. One outage episode records **one** strike no matter how many bots fail in it; a genuinely separate outage (after a bot became ready) escalates the bounded, jittered pause up to the maximum |
| `MC_AUTH_PROFILE` | `none` | `none`, `offline`, `microsoft`, `manual`, `authme`, `simpleauth` or `generic`. Plugin profiles are challenge-driven and never send a password without a server prompt. See `AUTHENTICATION_PROFILES.md`. |
| `MC_AUTH_REGISTRATION_ENABLED` | `false` | registration is opt-in and requires a registration template |
| `MC_AUTH_MAX_ATTEMPTS` | `2` | credential attempts per challenge, clamped to 1–5 to avoid lockout loops |
| `MC_AUTH_LOGIN_TEMPLATE` / `MC_AUTH_REGISTER_TEMPLATE` | profile default | optional per-server command forms; must contain `{password}`. Blank uses AuthMe's confirmation form or SimpleAuth's single-password form. The older `MC_LOGIN_COMMAND` / `MC_REGISTER_COMMAND` names are honoured when explicitly set |
| `MC_CREDENTIALS_FILE` | `.mc-auth.json` | ignored per-bot credential file; never committed and never echoed |
| `MC_REGISTER_PASSWORD` / `MC_LOGIN_PASSWORD` | *(empty)* | legacy single-fleet credentials, used only when a plugin profile is explicitly selected |
| `MC_AUTH_ENABLED` | `false` | optional explicit enable for legacy/profile paths; the default profile already decides |
| `MC_AUTH_DELAY_MS` / `MC_AUTH_TIMEOUT_MS` | `300` / `12000` | delay before an auth attempt and the challenge/confirmation timeout |
| `MC_RECONNECT_JITTER_MS` | `4000` | jitter added to reconnect attempts so five bots do not retry together |
| `MC_DNS_TIMEOUT_MS` | `10000` | DNS preflight budget, timed separately from TCP and reported as its own stage |
| `MC_CONNECT_TIMEOUT_MS` | `45000` | TCP connect stage timeout, measured from the socket attempt |
| `MC_VIEW_DISTANCE` | `2` | requested chunk radius: an integer 2–32, or `tiny` (6), `short` (8), `normal` (10), `far` (12). Ten bots at 6 kept 1,690 chunk columns in one process and froze the event loop for 26s, so an old env value is logged and capped by `MC_VIEW_DISTANCE_MAX` |
| `MC_VIEW_DISTANCE_MAX` | `2` | hard cap for the effective radius. Raise it only after the Connections page shows the host can absorb the chunk burst; a five-bot process is the constraint, not one bot |
| `AUTONOMY_WARMUP_MS` | `20000` | live delay after every configured bot (`config.team.names`) is ready before any pathfinder starts, so the spawn chunk burst finishes first. Simulation and unit tests skip it |
| `AUTONOMY_AUTO_PLAN` | `false` | create the survival-base objective automatically. Off by default so a fresh launch has an empty task board and idle bots; enable at runtime with `team plan on` or set `true` to plan from the first tick |
| `AUTONOMY_CONCURRENCY` | `4` | maximum bots inside a long controller action at once. Others run safety work and rotate into the next free slot |
| `ACTION_TIMEOUT_MS` | `60000` | hard budget for one autonomous controller step. A hung path or dig is cancelled, movement is stopped and the concurrency slot is released. Operator commands run in their own exclusive slot and cancel the autonomous step instead of racing it |
| `EMERGENCY_BUDGET_MS` | `6000` | hard budget for one safety pass (eat, flee, defend). It is propagated to combat and pathfinding as a deadline, and a watchdog cancels movement at `budget + 750ms`; routine task work keeps the longer `ACTION_TIMEOUT_MS` |
| `SAFETY_PREEMPT_MS` | `500` | while a task is running, check for damage, lava, fire, a fall or critical health this often. A hit cancels a non-combat task so the next safety pass owns movement; combat tasks still yield to critical health and hazards |
| `PATHFINDER_THINK_TIMEOUT_MS` / `PATHFINDER_TICK_TIMEOUT_MS` / `PATHFINDER_SEARCH_RADIUS` | `2500` / `10` / `64` | cooperative A* budget for autonomous tasks: total decision time, slice per event-loop turn, and the adaptive search-radius floor |
| `PATHFINDER_OPERATOR_THINK_TIMEOUT_MS` / `PATHFINDER_OPERATOR_TICK_TIMEOUT_MS` | `8000` / `25` | a larger A* budget for operator `goto`/`come`/`follow`. The old shared 2.5 s/10 ms budget made long go-to requests fail with “Took to long to decide path to goal”. The terminal reports the measured plan/follow split |
| `NAV_ADAPTIVE_SEARCH_RADIUS` / `NAV_SEARCH_RADIUS_SCALE` / `NAV_SEARCH_RADIUS_MAX` | `true` / `1.5` / `512` | scale the pathfinder detour budget with distance (`scale × straight + 16`), clamped between the floor and the ceiling |
| `NAV_TASK_ATTEMPTS` / `NAV_OPERATOR_ATTEMPTS` | `2` / `3` | bounded attempts: a task gets one recovery retry, an operator move three, before an honest failure |
| `NAV_STUCK_WINDOW_MS` / `NAV_RECOVERY_DELAY_MS` | `2500` / `250` | no-progress window that stops a stale path, and delay between recovery attempts |
| `NAV_WAIT_FOR_WORLD_MS` | `750` | short fallback wait when the destination chunk has not loaded at the bot's current loaded frontier. Moving to a loaded frontier stance normally loads it sooner; the wait never treats unknown terrain as air |
| `NAV_ROUTE_MODE` | `balanced` | route profile: `safe`, `fast`, `balanced`, `cautious`, `follow`, `combat`, `retreat`, `task`. It changes drop depth, water/hazard costs and narrow-corridor cost, never the standability rule |
| `NAV_PLAN_BUDGET_MS` | `700` | ceiling for one deterministic plan. A shared deadline covers every segment of one move, so a long route cannot exceed it. 700 ms is the measured value that keeps a five-bot build inside the shared window under test load; 350-500 ms starved it |
| `NAV_DIMENSION` | `overworld` | dimension envelope: `overworld`, `nether` or `end`. It caps safe drops in the Nether/End and rejects targets outside the dimension's build height |
| `CLIENT_STALL_GUARD_MS` / `CLIENT_STALL_RESUME_MS` | `2500` / `1500` | if the 20 tps client tick loop arrives this late, stop the stale path, re-anchor to the last server position and hold movement for the resume window. A 5s+ freeze also probes the socket with a real swing so a dead session reconnects instead of showing as online |
| `MC_RECONNECT_*` | see below | reconnect backoff. Supervision now runs on its own 1.5s timer, independent of long mining or movement actions |
| `MC_INBOUND_YIELD` | `true` | pause the inbound socket between kernel reads so a chunk burst cannot monopolise one event-loop turn |
| `MC_LOGIN_TIMEOUT_MS` | `30000` | handshake/login stage timeout; separate from configuration, spawn and AuthMe so failures are diagnosable |
| `MC_CONFIGURATION_TIMEOUT_MS` | `15000` | configuration-exchange budget once the server sends `start_configuration` |
| `MC_SPAWN_TIMEOUT_MS` | `45000` | spawn stage timeout |
| `MC_KEEPALIVE_MS` | `60000` | client-side no-packet watchdog passed to Mineflayer. The library still sends the reply itself; the reconnect supervisor owns recovery |
| `MC_STALE_AFTER_MS` | `45000` | a spawned bot with no inbound packet this long is reported as `No packets`; it stays **online** in the current snapshot but the supervisor force-closes and reconnects the zombie socket |
| `MC_SKIN_ON_JOIN` / `MC_SKIN_COMMAND` / `MC_SKIN_DELAY_MS` | `true` / `/skin uH3WR2v0ti0uTHJ` / `1500` | send one cosmetic skin command per ready session, after spawn and password auth. Non-fatal; shown on bot profiles and Connections |
| `MC_REJOIN_DELAY_MS` | `5000` | hold-down before the first rejoin after a real session ends; the reconnect supervisor and throttle queue still apply |
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
the ten accounts, and keep the new value only in an untracked `.env`. `npm run check:secrets` fails if
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

Every command is reported in the terminal: an accepted/start line, then status, duration, source/operator, the key result fields,
up to twelve per-bot rows, and (for movement) the setup/plan/follow split plus any queue or
cancellation wait. The CLI prints that human report first and then the full JSON contract; set
`CHICKENBOTS_RAW_JSON=0` to suppress the JSON. A `goto` now uses an operator-sized A* budget, reports
`from`, `requested`, `distance` and `commandMs`, and fails immediately with `PATH_NOT_FOUND` (rather
than re-planning the same map three times) when the pathfinder honestly finds no route.

```
help [command]                 status                         diagnostics
ai [status|off]                team [state|on|off|plan on|plan off|memory|locks|tasks|roles|leader|formation|resources|objectives|follow|regroup|retreat|defend|reassign]
goto <x> <y> <z> [bot]         goto <bot|all> <x> <y> <z>      # leader by default; block Y is lifted to a standable feet position
bot <name|all> <status|where|goto x y z|come|follow|stop|return|eat|mine [ore|block]|chop [type]|farm [plant [crop] [count]|maintain|status|crop]|fish [n]|defend|combat|guard [x y z]|duel <player>|explore [n]|sleep>
inventory [bot]                eat [bot]                       sleep [bot|all|auto on|off]
survival [bot|all] [eat|healing|armour|tools|crafting|shield] [on|off]
auto <eat|healing|armour|tools|crafting|shield|weapon|totem|potions|food> [on|off] [bot|all]
mine [bot|all] [ore|block|stop]   chop [bot|all] [species|stop]   farm [bot|all] [plant [crop] [count]|maintain|status|crop|animals|stop]
woodcutting [status|stats|trees [type] [radius]|chop [type]|store|relocate|plant|stop] [bot|all]
woodcutting team [status|auto|assign <bot> <CHOPPER|SCOUT|HAULER|PLANTER|GUARD>]
woodcutting support [request <kind> [count]|fulfil <id>] [bot|all]   woodcutting catalog [version]
fish [bot|all] [casts]          fish stop [bot|all]            eat [bot|all]
batch <bot|all> <action> [args] then <action> [args] ...   # sequential, per-bot results
bot all <action>                # one command tasks every gameplay-ready bot
defend [bot|stop]              explore [bot] [steps] | explore stop [bot|all]
# Every command accepts --help (side-effect free); `npm run commands:audit` exercises the surface.
combat [status|on|off|start|stop|mode|guard|duel|rescue]   pve [on|off|status]   pvp [on|off|status]
target [add|remove|protect|unprotect|clear|list] <player>                   arena on [radius]|off
follow <player|bot> [distance 2-16] | follow stop
players [list [category]|near [radius]|info <player>|history <player>|events|refresh|follow <player> [bot|all] [distance]|unfollow [player] [bot|all]|guard <player> [bot|all] [radius]|escort <player> [bot|all]|observe <player> [bot|all]|unwatch [player] [bot|all]|come <player> [bot|all]|stop [bot|all]|give <player> <item> [count] [bot|all]|drop <player> [loot|item] [count] [bot|all]|message <player> <text>|greet <player>|note <player> <text>|tag <player> <tag>|untag <player> <tag>|forget <player>|pvp [status|on|off]|mode <EXPLICIT|ARENA|DEFENSIVE>|target [add|remove|list] [player]|protect|trust|unprotect|untrust <player>|arena [list|on [radius] [name]|add <name> <x1 y1 z1 x2 y2 z2>|remove <name>|clear]]
gear [status|optimise|durability|progression|layout] [bot]    totem [status|reserve [n]|refill]   food|potions [status] [bot]
guard x y z [bot] | guard stop             duel <player> confirm
team combat [status|on|off|retreat|regroup|rescue|heal|attack <player>]
find <village|mineshaft|temple|ruin|forest|cave|diamonds|emeralds|iron|...> [bot]
return home [bot|all]
task <list|add TYPE [label] [--params JSON|key=value...]|assign|priority|info|cancel|retry|objective|fleet TYPE [params]> ...
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
node src/cli.js --simulate "players list"
node src/cli.js --simulate "players guard Alex all 8"
node src/cli.js --simulate "gear progression 10101000"
node src/cli.js --simulate "team combat heal"
node src/cli.js --simulate "team combat retreat"
node src/cli.js --simulate 'task add MINE_BLOCK iron --params {"block":"iron_ore","limit":8}'
node src/cli.js --simulate "task add STORE_ITEMS deposit item=bread count=8"
node src/cli.js --simulate "task list"
```

---

## Dashboard

A modular operations console served from `src/dashboard/public/` with 41 routed views, grouped so
that related tasks sit together rather than in one long tab strip:

* **Overview** – fleet summary, live vitals chart, activity feed and objectives.
* **Live World** – a bounded 3D view rendered from real block data (`/api/world`): exposed surface
  heightfield, chunk accounting, live bots/entities, orbit/zoom/pan, click-to-select and follow,
  FPS/frame/triangle/draw-call instrumentation and a 2D fallback when WebGL is unavailable.
* **Activity** – live activity, notifications and logs.
* **Fleet** – all bots, **Players**, team board, profiles and connection management. The Players
  page lists every player any bot has seen (plus server-list players with no position yet), with
  presence/movement freshness, UUID-backed renames, notes, tags and history. Follow, unfollow,
  guard, escort, observe/unwatch, come, greet, give-item, drop-loot and message controls are live.
  The PvP policy panel edits the explicit target list, protection/trust and arena bounds, and
  selects EXPLICIT, ARENA or DEFENSIVE mode. A dedicated **Following players & watches** section
  lists active follows, guards, escorts and passive observations with per-row cancel actions;
  unfollow clears only follow watches, never guard or escort.
* **Gameplay** – survival, inventory, mining, excavation, woodcutting, farming, fishing,
  exploration and sleep. The Woodcutting section shows per-bot role, axe, verified log/sapling
  counts, reservations, support requests and catalogue data, with live scan, chop, store, relocate,
  plant, stop, role-assignment and support actions. Mining shows per-bot pickaxe tier and work
  zone, sums the `oresMined` map correctly, exposes the cached status-scan age, lists sampled ores
  with distance and supports both a typed deep target (`diamond`, `stone`, …) and a per-bot stop.
  Every value comes from the runtime snapshot.
* **Combat Operations** – combat overview and live engagement log, team roles/focus/retreat,
  per-bot equipment and durability, totem/supply ledger, explicit PvP targets, protection list and
  arena configuration.
* **Builder Operations** – builder overview and pipeline, builder projects, site survey, site
  preparation, lighting, material planning, warehouse/storage, team assignments, QA & security.
* **Legacy construction** – home base, builder, schematic library (filters, pagination, isometric
  preview), build projects and project history.
* **System** – task manager, logs/diagnostics and settings.

Every shell response carries `X-Chickenbots-Build` and a content-derived build id
(`<version>+<git7>.<frontend12>.<backend12>`). HTML is served `no-store`; asset URLs are rewritten
at serve time to `?v=<frontend hash>` (including nested ES-module imports) and served `immutable`
only for the current hash. `/api/build` and **Settings → Build & version** expose both hashes and
both build ids, and the shell raises a reload banner if the loaded module graph no longer matches
the backend. There is no service worker, so a reload cannot resurrect a stale app shell. A typed
deep link such as `/players` boots the shell for a known route; unknown paths still return 404.
The deep-link fallback is a pathless middleware registered after every API route, not an
`app.get('*')` wildcard: Express 4 and Express 5 (path-to-regexp 8) both accept it, while the old
string wildcard crashes Express 5 during route registration with `Missing parameter name at index
1: *`. Missing `.js`, `.css`, image and download URLs always return a plain 404, never the HTML
shell; unknown `/api` paths always return JSON. If the dashboard itself cannot initialise or bind,
the runtime logs the full stack, reports `Dashboard unavailable`, and keeps the bot fleet running
headless rather than aborting the process.

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
`online`, `ready`/`gameplayReady`, `transportConnected`, `serverPlayerListed`, `spawned`,
`authenticated`, `authPending`, `status` and `statusLabel`; the overview, fleet, team, CLI and
diagnostics views render that verdict instead of re-deriving it. **Online and ready are separate.**
A spawned bot the server still lists is online even while it is starting, dead, out of packets or
blocked by manual auth. Only `gameplayReady` (online + spawned + no pending auth + live entity)
unlocks commands and autonomy. Other states (`Joining`, `Online — starting`,
`Online — auth required`, `Online — auth failed`, `Dead — online`, `No packets`, `Offline`) are shown
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

Known environment constraints: `npm run schematics:validate` regenerates all 10,000 designs and takes
roughly six to twenty minutes depending on the machine; the full validation pass is therefore not
part of the default `npm test`. `npm run validate` reuses a saved full report only when that report
is newer than the manifest and covers the same number of designs; a regenerated or edited manifest
forces the real full pass.


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

`data/schematics/manifest.json` contains **10,000 unique generated designs**
(10,000 unique geometry hashes, 27,821,660 blocks). Each blueprint is
reconstructed and audited through `BuildEngine.validateBlueprint()` and its
dependency planner, including its palette, phases, foundation/supports and
materials. The runtime reports the real count (base + custom) at all times.

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
it also probes `/healthz`, `/api/state` (including ten combat controllers), `/api/commands` and the
dashboard shell, so a broken preview or a missing combat/construction snapshot fails before
commissioning.

## Limitations / next commissioning step

* Live server behaviour depends on the actual Aternos plugins, ViewDistance, pathfinding and
  latency; the runtime surfaces connection errors and refuses autonomy until all five bots are ready.
  Bots are spaced by `MC_CONNECT_STAGGER_MS` and `MC_JOIN_INTERVAL_MS` (positive by default, with jitter). If Paper/Aternos applies a
  per-IP join throttle, that throttle or a socket that never reaches spawn pauses **every** join. All failures in the same
  outage are one strike, so four bots timing out do not turn a 90s pause into 10 minutes; a bot that
  becomes ready closes the episode and clears the pause, and only a separate later outage escalates
  the bounded, jittered backoff. Only one live runtime may run per checkout: a PID lock
  (`data/runtime/live.pid`, shared by the dashboard and the CLI) refuses a second instance, because
  duplicate logins make Aternos close the first socket as an uninformative `EPIPE`/`ECONNRESET`. If startup reports the lock is held, run
  `cat data/runtime/live.pid` and `ps -p <pid> -o pid,etime,cmd`; connect to that instance's
  dashboard (default `http://127.0.0.1:3000`) or stop it with `kill <pid>`. The lock is removed on a
  clean exit; delete `data/runtime/live.pid` only after confirming that no such process exists.
  If you control the server, set
  `settings.connection-throttle: 0` in `bukkit.yml` if the burst is being rejected; otherwise the
  runtime's bounded backoff handles it. A bot that drops re-enters the same queue after
  `MC_REJOIN_DELAY_MS` (5s by default), and the reconnect supervisor keeps running even while
  autonomy is paused. Connected bots send a real swing animation every 30s so a writable session is
  visible to idle plugins. Chickenbots does **not** fabricate movement or jump to defeat AFK checks; the
  real 20 tps client tick loop is the fix for a client that looks frozen.
  The default `MC_AUTH_PROFILE=none` sends **no** `/login` or `/register`. Credentials left in
  `.env` while the profile is `none` are intentionally idle; startup warns and names the profiles
  to select only if the server actually requires plugin authentication. The live 26.1 server
  answered `/login` with `Unknown or incomplete command`, so the password exchange was not merely
  failing — the server had no such command. Plugin authentication is now opt-in through an explicit
  profile. `authme`/`simpleauth` wait for the server's own challenge; a missing challenge returns
  `AUTH_PROMPT_TIMEOUT` and sends nothing. Attempts are bounded by `MC_AUTH_MAX_ATTEMPTS`. Per-bot
  passwords live in an ignored `.mc-auth.json`, never in Git or chat. A `manual` profile keeps the
  spawned session online, reports `AUTH_REQUIRED_MANUAL`, shows `Online — auth required`, and blocks
  gameplay. Online presence and gameplay readiness are separate fields everywhere (CLI, dashboard,
  coordinator): a spawned bot is online even while starting, dead or auth-blocked.
  An operator/staff kick or a ban pauses automatic retries for that bot;
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
  up to 625 chunks per bot. `minecraft-protocol` 1.68.0 decompressed each compressed frame with
  synchronous `zlib.unzipSync`; Chickenbots replaces that transform with async `zlib.unzip` as the
  library loads, and the inbound socket yields between kernel reads (`MC_INBOUND_YIELD=true`).
  Decompression is not the only cost, though: parsing a chunk column and applying its block updates
  is still synchronous. Ten bots at `tiny` (6) held 1,690 columns and froze the loop for 26s in the
  03:18 live run, after which the server dropped four sessions with `EPIPE` and one with
  `invalid_player_movement`. The default is therefore `MC_VIEW_DISTANCE=2` (25 columns per bot).
  An explicit `MC_VIEW_DISTANCE=tiny` from an older `.env` is capped by
  `MC_VIEW_DISTANCE_MAX` (default 2) and the clamp is logged at startup. Raise that cap only when the
  Connections page shows the host can absorb the burst.
  The runtime also waits `AUTONOMY_WARMUP_MS` (20s) after the tenth ready before starting
  pathfinders, bounds concurrent controller actions (`AUTONOMY_CONCURRENCY=4`), and gives
  reconnect supervision its own 1.5s timer so a long mining/movement action cannot delay a rejoin.
  If the client tick loop is ever more than `CLIENT_STALL_GUARD_MS` late (event-loop freeze or host
  suspend), movement is dropped, the stale path is stopped and the entity is re-anchored to the last
  server position before any new packet is sent. The Connections page reports mean/p99/max delay
  from `monitorEventLoopDelay`. The pre-teardown snapshot also records the last
  inbound/outbound packet name, pending socket bytes and the last valid state, and
  `/api/diagnostics/export` downloads a redacted state + log bundle for support.
  With `MC_VERSION=auto`, Chickenbots validates the server status ping once before opening any login
  socket. A sleeping/starting Aternos instance commonly reports protocol `-1`; the runtime waits for a
  real version instead of sending five bots into mineflayer's autoVersion crash path. While the probe
  is unresolved the reconnect supervisor does not start login sockets, so a sleeping server is not
  charged as ten bot connection attempts or retry backoff.
  The resolved version must be listed in `minecraft-protocol`'s supported-version set. If a proxy
  advertises a newer status name than the protocol it answered with, the protocol mapping wins.
  `LOG_LEVEL=debug` (opt-in; the default is `info`) adds lifecycle detail. Server chat is logged
  (bounded) so an unexpected manual-auth prompt is visible without debug logging. No auth command is
  sent or re-sent. Per-packet movement, keepalive and position
  traces stay off even then unless `MC_TRACE_PACKETS=true`: writing
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
