# V6 Players & Woodcutting Overhaul — Final Report

**Scope:** full rebuild of the Players subsystem and the Woodcutting subsystem, including backend
controllers, command surface, dashboard management UIs, fleet teamwork, no-AI compliance, an
explicit bug-fix pass, and verification.

**Branch:** `arena/de11bd2d-chickenbots`
**Status:** complete and uncommitted (no commit or push was requested).
**Verification run:** 2026-11-22 (sandbox clock 2026-11-26 in test logs).

---

## 1. Outcome

| Area | Result |
|---|---|
| Full test suite | **492 / 492 pass**, 0 fail, ~137 s |
| Lint | **191 files**, 0 errors, 5 pre-existing warnings in untouched files |
| Consistency gate | **10 / 10 pass** |
| Command audit | **47 / 49 executed or help-audited, 0 failures** (`stop` skipped by design; `exploration path` has no safe probe; `woodcutting` now probed) |
| Deploy check | **13 / 13 pass** |
| Dashboard smoke | simulated server on `0.0.0.0:4179`: `/` and `/api/state` 200, 5 woodcutting rows, team rows, 9 catalogue entries, JS assets 200 |
| AI / API-key code paths | **none** — consistency gate reports `AI disabled and keyless — deterministic mode` |
| Git | working tree only; no commit, no push, no PR |

The 5 lint warnings are pre-existing (`realBot.js` unused `StuckDetector`/`movePriority`;
`standability.js` unused imports). No new lint warnings were introduced.

---

## 2. Players subsystem

### 2.1 Directory and identity

`src/players/registry.js` is now a real shared directory rather than a per-bot sighting list.

- Case-insensitive keys, canonical display names, UUID-backed rename merging.
- Presence states: `visible`, `online`, `recent`, `offline` (15 s presence window; position
  freshness 5 s).
- Per-bot distances are recomputed per scan and never leak a remembered distance.
- Manual records are **not** expired by the observation TTL, so operator notes/tags survive.
- Disconnect clears that bot's activity, preventing a false active watch.
- Categories: `trusted`, `protected`, `target`, `neutral`, `unknown`, `staff`, with trust checked
  before protection because policy intentionally treats trusted players as protected-safe.
- Tags, notes, bounded history and a bounded team event feed.
- Roster bots are rejected by `cleanName` and stay out of the player directory; team presence is
  owned by the Bots page/`team state`. The UI no longer offers a permanently empty “team” filter.

### 2.2 Player controller

`src/players/controller.js` supports **FOLLOW / GUARD / ESCORT / OBSERVE** as distinct modes.

- Player-name matching is case-insensitive for lookup and unfollow.
- A live entity is required before acting; registry freshness is still enforced.
- `PLAYER_OFFLINE` is returned instead of acting on a stale entity; an offline target
  auto-stops a watch after the grace period.
- `OBSERVE` never pathfinds — it only records presence and last position.
- `GUARD`/`ESCORT` defend the player against hostile mobs and against **authorised PvP players**
  when the policy allows engagement.
- Team bots return `TEAMMATE`, not a misleading invalid-name error.
- Follow/guard/escort are deliberately not cleared by `unfollow`; only FOLLOW is.

### 2.3 PvP policy

`src/combat/players.js` provides one fleet-shared policy.

- Modes: `EXPLICIT`, `ARENA`, `DEFENSIVE`.
- Authorisation is explicit-only; teammates, protected and trusted players can never be targets.
- Arena normalisation, add/remove/clear, and enforcement of bounds.
- Distinct refusal codes: `NOT_EXPLICIT`, `ARENA_REQUIRED`, `ARENA`, `NOT_RETALIATION`,
  `OFFLINE`, `STALE_POSITION`, `DIMENSION`, `PROTECTED`.
- **DEFENSIVE is genuinely functional:** a real recent hit from a named player is recorded as
  defensive evidence, after which retaliation is allowed. A team-wide opening attack remains
  impossible.
- Missing target position now fails an arena check instead of silently allowing the attack.
- Audit trail is bounded; constructor-supplied targets/protection/trust/arenas are initialised
  before they are audited (this was a real startup crash and is regression-tested).

### 2.4 Players commands

`players` (alias `player`) is a first-class command family:

```
players list [category] | near [radius] | info <player> | history <player> | events | refresh
players follow <player> [bot|all] [distance] | unfollow [player] [bot|all]
players guard <player> [bot|all] [radius] | escort <player> [bot|all] | observe <player> [bot|all]
players unwatch [player] [bot|all] | come <player> [bot|all]
players give <player> <item> [count] [bot|all] | drop <player> [loot|item] [count] [bot|all]
players message <player> <text> | greet <player>
players note <player> <text> | tag <player> <tag> | untag <player> <tag> | forget <player>
players pvp [status|on|off] | mode <EXPLICIT|ARENA|DEFENSIVE>
players target [add|remove|list] [player]
players protect|unprotect|trust|untrust <player>
players arena [list|on [radius] [name]|add <name> <x1 y1 z1 x2 y2 z2>|remove <name>|clear]
```

Stable behaviour verified: target/protect/trust changes are shared by all five controllers;
`players info` finds watches case-insensitively; fleet fan-out preserves per-bot result rows.

### 2.5 Players dashboard

`src/dashboard/public/js/pages/players.js` is a working management surface:

- Search and category filtering over real snapshot rows.
- Presence, distance, dimension, UUID, gamemode/ping, seen-by and watched-by fields.
- Follow, unfollow, guard, escort, observe, unwatch, come and greet buttons.
- PvP panel for on/off, all three modes, targets, protection/trust and arenas.
- Inline note/tag forms backed by real commands.
- **Following players & watches** table with per-row cancel.
- Recent team events and directory statistics.
- Empty/error states; no invented player or event data.

---

## 3. Woodcutting subsystem

### 3.1 Catalogue

`src/woodcutting/catalog.js` supplies a version-aware species/log/sapling/leaves catalogue for
oak, spruce, birch, jungle, acacia, dark oak, cherry, mangrove and pale oak. Unsupported species
are still identifiable but reported as unsupported for the negotiated server version.

### 3.2 Tree identification and chopping

`src/actions/woodcutting.js` was rebuilt around verified block changes.

- Bottom-up trunk chopping from the nearest reachable layer.
- 1x1 and 2x2 trunks, tall trunks, stripped logs and `_wood` blocks.
- Up to four deduplicated adjacent stances are tried, at most two before an honest reach failure.
- Dig reach is checked from both the eye ray and the adapter's feet-distance gate, so a log that
  is reachable by the real adapter is not rejected by the planner.
- Every removal is verified against the world; inventory gains are measured before/after.
- Short trees with no ground support to verify lose confidence rather than being claimed.
- Leaves are cleared only when in reach, and saplings are collected from confirmed drops.
- Species-correct replanting on the original soil; 2x2 trees require the full 2x2 sapling square.
- Axe selection is tiered; a bot with only logs now converts them to planks/sticks and crafts a
  real wooden axe before chopping.
- `storeLoot` deposits only what a real storage window accepts and keeps tools/armour.
- `relocateForTrees` stays inside the work zone and reports `SEARCH_EXHAUSTED` honestly.
- Fleet tree leases prevent two bots from walking to the same trunk.
- Task counters reset per operation; lifetime counters persist.

### 3.3 Fleet teamwork

`src/woodcutting/team.js` adds five roles: `CHOPPER`, `SCOUT`, `HAULER`, `PLANTER`, `GUARD`.

- Role assignment and `auto` distribution.
- Shared, bounded support request queue with `request` / `fulfil`.
- Reservation view shared with mining.
- `GUARD` attacks a confirmed hostile within 8 blocks before starting a harvest.
- `SCOUT` gets a slightly wider relocation budget; `PLANTER` plants before chopping; `HAULER`
  stores surplus.
- Team status reads the runtime's warmed controller cache, so a dashboard snapshot never invokes
  a live `controller.status()`.

### 3.4 Woodcutting commands

```
woodcutting status|stats [bot|all]
woodcutting trees [type] [radius] [bot|all]
woodcutting chop [type] [bot|all]
woodcutting store [bot|all]
woodcutting relocate [bot|all]
woodcutting plant [bot|all]
woodcutting stop [bot|all]
woodcutting team [status|auto|assign <bot> <ROLE>]
woodcutting support [request <kind> [count]|fulfil <id>] [bot|all]
woodcutting catalog [version]
```

`woodcutting` and `forestry` are aliases. `chop`/`trees` argument parsing was corrected so species
and radius may appear in the documented order without being mistaken for a bot name.

### 3.5 Woodcutting dashboard

The Woodcutting page now shows per-bot role, task, axe and durability, verified log/sapling
counts, trees chopped, replants, reservations and open support requests, plus the catalogue.

Available live actions: Scan (per bot, renders real tree results in a toast), Chop all, Store,
Relocate, Plant and Stop, role assignment, and support request/fulfil. Every button issues a real
command; the page does not fabricate a tree, drop or role.

---

## 4. Bug-fix pass (separate from feature work)

Defects found and fixed during the explicit pass:

1. **PvP constructor crash** — `_audit()` ran before `this.audit` existed when configured targets,
   protection or arenas were present. Constructor additions are now initialised and audited.
2. **Dashboard performance regression** — `WoodcuttingTeam.status()` called live controller
   status during snapshot generation. It now consumes the warmed cache.
3. **Trusted players categorised as protected** — relationship ordering corrected.
4. **`players` command crash** — `controller.pvp` does not exist; every path uses
   `actions.combat.pvp`.
5. **DEFENSIVE was decorative** — no damage evidence was ever recorded. Real recent hits from the
   named player now unlock retaliation; opening attacks still fail.
6. **Live entity treated as stale** — a live entity selected by assessment could be rejected using
   another bot's older registry cache. Live entities are now authoritative for presence/freshness.
7. **Arena with unknown target position allowed the attack** — now refused with `ARENA`.
8. **Manual notes/tags expired after the observation TTL** — manual records now persist.
9. **Disconnected bot left activity behind** — activity is cleared on disconnect.
10. **Tall/2x2 reach regression** — feet-distance gate added with correct integer-block semantics;
    six reachable base logs are chopped again.
11. **Axe crafting dead end** — a bot holding logs but no handle now converts planks and sticks.
12. **Case-sensitive unfollow/info** — player names are case-insensitive throughout.
13. **Teammate returned as invalid name** — now `TEAMMATE`.
14. **GUARD role matched only `entity.hostile`** — now uses the shared hostile classifier.
15. **Players “team” filter was permanently empty** — removed; team presence stays on the Bots page.
16. **Woodcutting scan had no visible result** — per-bot Scan now shows real species/coordinates/
    log count/confidence from the command payload.
17. **Dead/unused woodcutting code** — removed unused `leavesFor`, `reachFailures`, dead leaf
    delta logic and duplicate caps; lint is clean for touched files.
18. **Command audit had no woodcutting probe** — added `woodcutting status`; audit remains 0 failures.

---

## 5. Tests added

### `tests/players-overhaul.test.js` — 13 tests, all pass

Covers: UUID rename merge, presence/freshness windows, categories and policy precedence,
EXPLICIT/ARENA/DEFENSIVE semantics including real retaliation, manual-record persistence,
disconnect activity cleanup, teammate rejection, offline auto-stop, observe never pathfinding,
case-insensitive unfollow, snapshot exposure, full CLI sweep (list/near/info/history/note/tag/
protect/trust/target/mode/arena/observe/unwatch/events/refresh).

### `tests/woodcutting-overhaul.test.js` — 13 tests, all pass

Covers: version-aware catalogue, tree identification, 2x2 dark oak + 4-sapling replant,
species-correct birch replant, tall-trunk full chop, GUARD defending a real zombie, log-to-axe
crafting, partial-tree honesty, reservations/two bots, verified drop counters, real storage
deposit, roles/support, complete CLI sweep and a bounded 64-radius scan under 1.5 s.

### Existing suites

All pre-existing players, combat, woodcutting-safety, survival, command, dashboard, runtime and
integration suites still pass unchanged except for the intentional test count in
`tests/command-audit.test.js` (49 commands).

---

## 6. Verification commands and exact results

```text
npm test              → 492 tests, 492 pass, 0 fail, ~137 s
npm run validate      → secret leak PASS, lint PASS, tests PASS,
                        schematics PASS, consistency 10/10, VALIDATION PASSED
npm run commands:audit→ 47/49 executed or help-audited, 0 failures
npm run deploy:check  → 13/13 checks passed
npm run lint          → 191 files, 0 errors, 5 pre-existing warnings
```

Targeted reproducers:

```bash
node --test --test-concurrency=1 tests/players-overhaul.test.js
node --test --test-concurrency=1 tests/woodcutting-overhaul.test.js
node --test --test-concurrency=1 tests/woodcutting-safety.test.js
node --test --test-concurrency=1 tests/dashboard-performance.test.js
```

---

## 7. Acceptance matrix

| Requirement | Evidence |
|---|---|
| Players backend rebuilt | Registry v2 + controller modes + shared PvP policy; 13 dedicated tests |
| Player commands work | CLI sweep and command audit; target/protect/trust shared across five bots |
| Players dashboard works | Real snapshot rows, filters, notes/tags, watches, PvP panel; dashboard suites pass |
| Woodcutting backend rebuilt | Catalogue, verified chopping, replant, storage, relocation, roles, leases; 13 tests |
| Woodcutting commands work | `woodcutting`/`forestry` namespace exercised in tests and audit |
| Woodcutting dashboard works | Live per-bot actions, scans and support/role controls |
| Teamwork | Roles, shared leases, shared support queue, GUARD defence |
| No AI | Consistency gate: “AI disabled and keyless — deterministic mode”; no AI/API code path |
| Bug-fix pass | 18 defects found and fixed; regression tests for the important ones |
| Full regression | 492/492 tests; validate, audit and deploy checks pass |
| No unauthorised commit/push | Working tree only |

---

## 8. Honest limitations

- Verification is against the deterministic `MockBot`/`MockWorld` adapters. No live Minecraft
  server was contacted from this sandbox, so Mineflayer-specific behaviour (entity naming, dig
  reach edge cases, chest-window timing) still needs a live smoke run.
- The dashboard was validated by module/route/API tests, an actual simulated-server smoke
  (`/api/state`, page JS assets) and asset checks, not by an automated browser. The new controls
  use the same event/command plumbing as existing tested pages.
- `src/actions/inventory.js`'s `TOOL_MATERIALS` still omits iron/diamond axes (pre-existing);
  woodcutting selects them by tier and falls back honestly rather than pretending to craft one.
- `players list team` is intentionally not a directory category; roster bots never enter the
  player directory and are inspected with `team state` / the Bots page.

## 9. Files changed / added

Modified:
`README.md`, `scripts/command-audit.js`, `src/actions/combat.js`, `src/actions/index.js`,
`src/actions/woodcutting.js`, `src/combat/players.js`, `src/commands/index.js`,
`src/dashboard/public/js/pages/gameplay.js`, `src/dashboard/public/js/pages/players.js`,
`src/players/controller.js`, `src/players/registry.js`, `src/runtime.js`,
`src/runtimeState.js`, `tests/command-audit.test.js`.

Added:
`src/woodcutting/catalog.js`, `src/woodcutting/team.js`,
`tests/players-overhaul.test.js`, `tests/woodcutting-overhaul.test.js`, this report.

No commit or push was made.
