# Chickenbots V6 — Round 33: teamwork, work zone and tool self-sufficiency

**Starting head:** `8fc01cb` (Round 32)
**Branch:** `arena/de11bd2d-chickenbots`
**Scope:** mining/logging overhaul requested by the operator:
(a) bots must not all work the same trees, (b) make the work as fast as
possible, (c) a hard **100x100** work zone centred on home, and (d) `mine
diamonds` (and every other `mine` target) must obtain the required pickaxe
instead of stopping at "need pickaxe tier 3".

## What changed

### 1. One fleet-wide claim registry

`src/actions/reservations.js` is a small TTL lease registry shared by every
bot in the runtime (`runtime.reservations`). Tree keys are `tree:x,z` and ore
keys are `ore:x,y,z`.

- `ResourceReservations.claim(key, owner, {ttlMs})` is atomic and rejects
  `ORE_RESERVED`/`TREE_RESERVED` when another bot holds the key.
- `releaseOwner()` is called on disconnect, so a dropped bot cannot strand a
  trunk or vein for its TTL.
- `status()` exposes `claimed`, `released`, `expired`, `rejected` and current
  holders for diagnostics.

`WoodcuttingController.tick()` claims a trunk before walking to it and skips
reserved trunks during the scan. `MiningController.mineOre()` claims the ore
before pathing and returns `ORE_RESERVED` with the holder when a teammate owns
it. `mineNearby()` reports how many ores were skipped as reserved.

### 2. Hard 100x100 work zone

`src/world/workZone.js` builds a square around `runtime.home`:

```
minX = floor(home.x) - floor((size-1)/2) - margin
maxX = minX + size - 1
```

For the default `WORK_ZONE_SIZE=100`, home `0,0` gives `-50..49` on both axes
(100 blocks wide). `WORK_ZONE_MARGIN=2` is an optional inset used when
returning or relocating, so a bot does not stand exactly on the boundary.

Enforcement points:

- `WoodcuttingController.findTrees()`/`chopTree()` and all relocations;
- `MiningController.mineOre()`/`mineBlocks()` and both shaft and branch
  tunnelling steps;
- `mineNearby()` and `mineOresDeep()` return to the zone first and refuse an
  out-of-zone target with `OUTSIDE_WORK_ZONE` (including the zone in the
  error);
- `BotActions` relocation and autonomous chopping use clamped coordinates.

`WORK_ZONE_ENABLED=false` remains an explicit expedition opt-out. `doctor`
now includes a `work-zone` check that asserts the reported width equals the
configured size.

### 3. Tool bootstrapping for every target

`src/actions/miningCatalog.js` is the single source of truth for ore/block
pickaxe tiers, drop names and aliases. `requiredPickaxeTier()` is alias-aware
(`diamond` -> `diamond_ore` -> tier 3), and `mine <target>` accepts both ores
and minable blocks (`stone`, `deepslate`, `obsidian`, `netherite`,
`ancient_debris`, `dirt`, ...).

`MiningController.ensurePickaxeFor(target)` walks the tier ladder:

| tier | tool | self-service chain |
|---|---|---|
| 1 | wooden pickaxe | sticks from logs/planks; if no wood, one reserved tree is chopped inside the zone |
| 2 | stone pickaxe | craft sticks + mine 3 cobblestone |
| 3 | iron pickaxe | mine 3 iron ore, mine coal for fuel if none, place/use a furnace, smelt 3 ingots |
| 4 | diamond pickaxe | mine 3 diamonds with the tier-3 pick |

Every `mine` path calls this gate when it finds a target harder than the
current pick. `mineNearby()` with no explicit ore scans the visible ores,
picks the hardest one, ensures that tier, then re-scans. `mineBlocks()` does
the same for the requested block. Success still requires a verified block
removal; a missing ore/tool is reported as `ok:false` with the step chain.

### 4. Throughput

- Ore collection is batched only after a run; an ore within mining reach is
  dug without a pathfinding call.
- `chopTree()` equips the axe once per tree instead of once per log.
- `mineNearby()` collects once at the end and logs an ore breakdown.
- `mine` summary now includes `breakdown` (e.g. `{raw_iron:3, coal:1}`) and
  the fleet aggregate adds per-drop totals.
- `WORK_ZONE` filtering happens before pathing, so bots do not spend a path
  budget on an out-of-zone tree.

## Evidence

All evidence is deterministic simulation or unit tests. **No live server was
reachable from this sandbox**, so live mining/chopping remains unverified.

- Two bots sharing one reservation registry: `________` chopped base `3,0`,
  `10101000` chopped base `8,0`, both `chopped:4`,
  `status() === {claimed:2, released:2, expired:0, rejected:0}`.
- Zone refusal: `chopTree({x:60,y:64,z:0})` returned
  `{ok:false, code:'OUTSIDE_WORK_ZONE', zone:{size:100,minX:-50,maxX:49,minZ:-50,maxZ:49}}`;
  `mineOre({x:60})` returned the same code.
- Diamond bootstrap (test `tests/mining-teamwork.test.js`): inventory
  `{oak_log:8, cobblestone:12, coal:1}`, no pickaxe ->
  `mineOresDeep({only:'diamond_ore'})` -> `{ok:true, mined:1}` with
  `tool:{have:3, steps:[wooden_pickaxe, stone_pickaxe, iron_pickaxe]}`,
  `raw_iron === 0`, `stats.toolBootstraps === 1`.
- Command path: runtime simulation with all pickaxes removed and iron/coal/
  diamond ore placed in view. `mine diamonds` completed in **301 ms**,
  `ok:true`, `mined:1`, `tool.have:3`; the bot ended with one iron pickaxe and
  one diamond.
- Block path: `mineBlocks({block:'stone'})` with only logs crafted a wooden
  pickaxe and mined stone; `mineBlocks({block:'dirt'})` needed no pick.
- Two-controller no-shared-trunk and `ORE_RESERVED` tests pass.

## Gates at this round

| gate | result |
|---|---|
| `npm test` | **406/406 pass** (11 new mining-teamwork tests) |
| `npm run lint` | PASSED (169 files) |
| `npm run commands:audit` | **45/46 covered, 0 failures** (stop deliberately skipped) |
| `npm run validate` | PASSED |
| `npm run deploy:check` | PASSED |
| `npm run check:secrets` | PASSED |

## Honest limits

- Live `chop`/`mine` and live movement remain **UNVERIFIED LIVE**; the
  sandbox cannot reach `EmpiSMP.aternos.me:32990`.
- The mock world has no ore near spawn. `mine`/`mine iron all` on the fleet
  simulation therefore returns an honest `ok:false`; that is not relaxed to
  make a demo green.
- **BUG-27-10** (event-loop blocks at `MINE_BLOCK`) is still open. This round
  reduces redundant pathfinding and scans, but does not claim to have removed
  the synchronous chunk cost.
- `npm audit` still reports 6 moderate findings via `uuid <11.1.1`; the
  dependency remains transitive and was not force-upgraded.
