# Chickenbots V6 — round 41 report

**Branch:** `arena/de11bd2d-chickenbots`
**Code commit:** `2dd6e56` — *Synchronise dashboard controls with the command registry*
**Base:** `e13e50a`
**Live build:** `6.0.0+2dd6e56.f865a9d433d3.4fbf0fb93ec3` (simulation, 5/5 bots)
**Report status:** this file is committed separately after the code commit.

### A. Root causes

The dashboard and the command layer had drifted in five independent ways:

1. **Two hand-maintained command views.** The registry was authoritative for
   handlers, but the browser kept its own target lists, enum lists and grammar
   assumptions in page modules. When a command gained an argument or a value
   (builder phase, mining targets, survival routines) the backend changed and
   the page did not.
2. **String concatenation as the action API.** Page code built lines such as
   `mine ${bot}${target}`, `builder assign ${bot} ${role}` and
   `task add ${type} ${label}`. Spaces, optional values and multi-word labels
   changed the token stream silently.
3. **Dispatch was mistaken for completion.** A 200 response or an accepted
   command was sometimes rendered as “complete”, even when the controller had
   mined nothing or only some of the fleet had succeeded.
4. **Wiring gaps that looked like working controls.** A phase selector was
   rendered but never sent; project priority was collected but never applied;
   a player tag form read the wrong field; build repair reached a pre-confirmed
   domain endpoint; the world viewer could centre on an offline leader.
5. **A confirmation hole in the command/builder boundary.** `build` accepted
   `confirm` but constructed the `SchematicBuilder` with `authorized: false`,
   so a confirmed build still failed on protected blocks. Conversely
   `build stop` and `build run` were advertised as confirmable yet the handler
   did not enforce confirmation, and `/api/builds/:id/action` always executed
   with `confirmed: true`.

### B. Website changes

Every route was audited through `NAV_GROUPS` / `router.js`; all 41 routes render.
The interactive surface was changed as follows.

| Page / section | Change |
| --- | --- |
| command palette | loads the real catalogue; shows category, summary, usage, required arguments, read-only and confirmation badges; searches aliases and required argument names; refuses an unknown command before posting |
| global command buttons | parse the line, resolve the command in the live catalogue, prompt when the exact invocation is destructive, show accepted vs failed honestly |
| global fleet buttons | validate the verb exists and that `all` cannot be duplicated (`chop all all …`); report per-bot failures and accepted counts; never claim completion without rows |
| Mining | server-provided target catalogue (10 ores, 46 blocks, aliases); leader / individual / fleet scopes; explicit per-bot stop; command preview; before/after counter and inventory evidence; partial-fleet verdict; result table with reported, counter delta and item delta |
| Survival | routine keys and labels come from registry metadata; per-bot and fleet toggles use `survival` / `auto` grammar |
| Woodcutting | role list from metadata; fleet chop uses `data-fleet-command`; stop is explicit; scan uses a real bot selector |
| Farming | fleet harvest/plant/maintain controls use the fleet grammar; status and errors remain backend-reported |
| Fishing | bot selector and 1–3 cast clamp; `fish <bot> <casts>` remains the exact CLI form |
| Exploration / world | online-only default centre; goto validates the selected bot; no invented locations |
| Combat | modes from metadata; guard derives coordinates from the live bot; duel is an explicit player form; target authorisation confirms; error path added |
| Combat targets | “Duel…” no longer sends a bare `duel`; guard uses the first real combatant; read-only target refresh does not prompt |
| Combat supplies | fleet-wide `totem refill` relabelled “Refill fleet” with an explanation |
| Players | PvP target authorisation confirms; target list is exempt from confirmation; tag form reads `tag`; target modes from metadata |
| Fleet / bot profile | structured assignments are formatted instead of `[object Object]`; survival switches from metadata; reconnect/disconnect remain confirmed |
| Team | formation buttons from `FORMATIONS`; assignments formatted; leader/team reads tolerate the live envelope |
| Builder projects | optional Y; integer origin validation; priority 0–100 applied with `builder priority`; design names quoted |
| Builder page | design names quoted in preview and start; origin required and integer-checked; build authorisation is explicit |
| Construction / building | build-card repair and cancel confirm before the endpoint; destructive endpoint replies are honoured; home tiers from the schematic library |
| Site / excavation | trench width max 16; box/flatten max 128; origin integers; design names quoted; start/stop confirmations retained |
| Warehouse / materials | no fabricated success; existing confirmation and inventory verification retained |
| Tasks | create-task uses structured `{name:'task',args}`; objective uses structured args; priority, assign and cancel continue through the registry |
| Home base | tier catalogue from `schematics.stats.tiers`; refuses an empty catalogue instead of posting an invented tier |

### C. Command changes

`src/commands/metadata.js` now documents all **49** commands with:

- canonical name and aliases;
- exact usage, examples, category and summary;
- argument schema: name, type, position, required/optional, enum values,
  numeric bounds, `valuesFrom`, flags;
- variants for legitimate alternate orders (`mine`, `goto`, `farm`, `chop`,
  `guard`, `path`);
- scope (`none`, `bot`, `fleet`, `botOrFleet`), read-only/mutates,
  cancellable, creates-tasks;
- confirmation policy and confirm subcommands;
- owning page and palette visibility;
- target source and expected error codes.

`CommandRegistry.annotate()` merges the table only after every handler is
registered. A missing, orphaned or duplicate entry, an invalid argument type, a
duplicate argument position or a duplicate subcommand fails startup/tests.

The catalogue endpoint now returns the mining target catalogue:

- `GET /api/commands` → `commands`, `targets`, `catalogue`, `history`, `taskTypes`
- `GET /api/commands/targets` → `source`, `ores`, `blocks`, `choices`, `aliases`, `defaults`
- `POST /api/command {name,args,confirm,operator,source}` →
  registry validation → serialisation → one execution
- `POST /api/command {line}` → unchanged tokenizer/CLI path

Enums are imported from their owners, not copied:

| Enum | Owner |
| --- | --- |
| team combat modes (8) | `TEAM_COMBAT_MODES` in `src/combat/team.js` |
| PvP target modes (3) | `TARGET_MODES` in `src/combat/players.js` |
| woodcutting roles (5) | `ROLES` in `src/actions/woodcutting.js` |
| survival routines (6) | `SURVIVAL_FEATURES` in `src/actions/survival.js` |
| formations (9) | `FORMATIONS` in `src/team/formations.js` |
| mining targets (56) | `miningTargets()` in `src/actions/miningCatalog.js` |

Corrected command contracts in this round:

- `builder assign <bot> <role> [--phase <phase>]` — phase is a flag, so a
  multi-word role remains one argument.
- `builder priority <projectId> <0-100>` — validated after project creation.
- `build verify [id]` / `build repair [id] [extras] confirm` — address a builder
  by id even when no construction project is active.
- `mine <bot> stop` — stops one bot; `mine stop` / `mine all stop` stop the
  fleet. A named leader is still named when only that bot is meant.
- `build stop` and `build run` now require explicit confirmation in the handler.
- Structured arguments are quoted only when needed; shell metacharacters remain
  rejected before tokenisation.

### D. Mining resolution

**Discrepancy found.** The page used a local “common” target array rather than
the backend catalogue, built `mine ${bot}` by interpolation, and treated a
successful dispatch as mined ore. Per-bot stop could send `mine <leader> stop`
which the old handler interpreted as a target. Fleet partial results were
flattened into one `ok` flag.

**Corrected contract.**

| Invocation | Meaning | Scope |
| --- | --- | --- |
| `mine` | leader mines nearby reachable ore | one bot |
| `mine <bot>` | named bot mines nearby | one bot |
| `mine <ore|block>` | leader targets that ore/block | one bot |
| `mine <bot> <ore|block>` | named bot targets it | one bot |
| `mine all` | all eligible bots mine nearby | fleet |
| `mine all <ore|block>` | fleet targets it | fleet |
| `mine stop` | stop every mining job | fleet |
| `mine <bot> stop` | stop only that bot | one bot |
| `mine all stop` | stop the fleet explicitly | fleet |

`mineArguments()` is the one frontend builder used by both the preview and
execution. `mine leader` is never generated. `mine` with a target goes through
the deep controller; no target uses `mineNearby()`. Blocks use `mineBlocks()`.
Stops call `stop()` for the exact selected set.

**Truthfulness.** After execution the page refreshes state and compares:

- handler-reported `mined` / `breakdown`;
- live mined-counter deltas;
- inventory item deltas for the target drop and known variants.

The verdict is:

- **Verified** only when a counter or inventory delta is visible;
- **Partial success** when verified work exists but the backend reports failed
  rows (fleet partials are not called rejected);
- **Reported, not yet observed** when the handler reports drops but no state
  delta is visible yet;
- **Rejected** / **No ore mined** with the backend code and error otherwise;
- **Stop accepted, not observed** when a stopped bot still reports active.

Tests cover the catalogue (every advertised target normalises and is mineable),
per-bot stop isolation, fleet stop, structured/raw parity, and the mining DOM
markers. The simulation harness verifies the result card, including a real
4-item stone result. No ore deposit or success result is fabricated in a test.

### E. Backend changes

- `src/commands/registry.js` — metadata merge/validation, structured execution,
  tokenizer-safe serialisation, confirmation policy helper, canonical alias
  handling, error codes.
- `src/commands/index.js` — metadata merge, catalogue exposure, mining target
  catalogue, builder phase flag, build verify/repair by id, build
  authorisation, `build stop`/`build run` confirmation, survival enum import,
  team combat enum import.
- `src/commands/metadata.js` — 49-command schema, single source for the
  operator surface.
- `src/actions/miningCatalog.js` — `miningTargets()` catalogue with kinds,
  ids, labels, aliases, variants, pickaxe tiers and drops.
- `src/actions/survival.js` — exported `SURVIVAL_FEATURES`, used by the
  controller and metadata.
- `src/combat/team.js` — exported `TEAM_COMBAT_MODES`, used by `setMode()` and
  metadata.
- `src/dashboard/server.js` — catalogue endpoints, structured command path,
  domain build actions routed through the registry, explicit confirmation on
  destructive build actions, JSON/static 404 separation preserved.
- `scripts/command-audit.js` — safe `path` probe; 48/49 commands covered,
  `stop` intentionally skipped.

### F. Teamwork

- Fleet commands still issue **one** command; the backend fans out with bounded
  concurrency and returns a row per bot.
- The dashboard reports observed counts and per-bot failures; it does not turn
  a mixed fleet result into all-success.
- Mining reservations, work-zone checks, pickaxe gating, shared task ownership
  and cancellation remain in the action controllers. The UI only displays
  their status and never bypasses them.
- `builder assign --phase` enters the same construction pipeline and task board.
- Task creation is structured; task assignment/priority/cancel use the shared
  task board and coordinator.
- `target list` is explicitly a read-only inspection; adding a PvP target
  requires an operator confirmation and still obeys protection/trust/arena
  gates.
- No AI call is required for any website, command, validation, action or
  planning path. `ai` reports deterministic mode; the hook is disabled and
  keyless.

### G. Cache and build identity

- Frontend and backend hashes are computed at startup; the current live build is
  `6.0.0+2dd6e56.f865a9d433d3.4fbf0fb93ec3`.
- The HTML shell is `Cache-Control: no-store` and carries
  `X-Chickenbots-Build`.
- Unversioned assets are `no-cache`.
- `?v=<frontendHash>` assets are `public, max-age=31536000, immutable`.
- A stale `?v=deadbeef` request receives `no-cache`; it is not trusted forever.
- `/api` responses are `no-store`; unknown API paths return JSON 404; missing
  static files return plain-text 404; known deep links receive the shell.
- `refreshCommands()` reloads `/api/commands` when the catalogue changes, so the
  palette cannot keep a stale in-memory list.
- A mismatched tab displays `#build-banner` with a working “Reload latest”
  action. There is no service worker or persistent module cache.

### H. Test results

Commands actually run in this checkout:

| Gate | Result |
| --- | --- |
| `npm test` | **PASS — 519/519**, 0 fail, 0 skipped |
| `npm run validate` | **VALIDATION PASSED** — tests, schematics, consistency 10/10, secret leak, lint |
| `npm run lint` | **PASSED** — 199 files, 5 pre-existing warnings (2 `realBot.js`, 3 `standability.js`) |
| `npm run commands:audit` | **48/49 executed or help-audited, 0 failures** (`stop` deliberately skipped) |
| `npm run deploy:check -- --url http://127.0.0.1:4179` | **17/17 checks passed** |
| `npm run test:routing` | **3/3 pass** |
| render-real harness | **52/52 pages rendered** |
| render-empty harness | **41/41 pages rendered before first snapshot** |
| mining harness | **OK** — leader/bot/fleet previews and a verified 4-item result card |
| command metadata tests | schema, enum provenance, structured parity, stop scoping, build-action confirmation |
| dashboard control tests | 97 static `data-command` literals, argument counts, fleet verb grammar, field names, dynamic mining grammar |

Live probes on the restarted preview:

| Probe | Result |
| --- | --- |
| `GET /api/build` | `6.0.0+2dd6e56.f865a9d433d3.4fbf0fb93ec3`, simulation |
| `GET /api/commands` | 49 commands, 56 target choices |
| `POST {name:"status",args:[]}` | 200, canonical `status` |
| `POST {line:"status"}` | 200, canonical `status` |
| `POST {name:"mine",args:["10101000","stop"]}` | 200, `mine 10101000 stop`, `stopped:true` |
| `GET /` | 200 shell, `no-store`, `X-Chickenbots-Build` |
| `GET /js/app.js?v=f865a9d433d3` | 200, immutable |
| `GET /js/app.js?v=deadbeef` | 200, `no-cache` |
| `GET /api/nope` | 404 JSON |
| `GET /js/nope.js` | 404 plain text |

A full live build was not started because the deterministic fleet did not hold
all 427 required materials; the build-action confirmation path is covered by a
real HTTP test that creates a builder with materials, then verifies:

- `POST /api/builds/:id/action {action:"cancel"}` → **400
  `CONFIRMATION_REQUIRED`**;
- the same request with `confirm:true` → **200**, state `CANCELLED`.

### I. Remaining issues

- **No real browser engine was available.** Rendering and DOM behaviour are
  exercised with happy-dom plus live HTTP. Canvas/WebGL visuals, real pointer
  events and CSS layout on physical mobile devices are **UNVERIFIED**.
- **No live Minecraft server was connected.** Simulation proves command
  wiring, state flow, refusals and result truthfulness; live pathfinding,
  block-state timing and server-specific inventory behaviour are
  **UNVERIFIED**.
- **Five pre-existing lint warnings** remain in `realBot.js` and
  `standability.js`; they are unrelated unused imports/variables.
- **Deliberate audit skip:** `stop` shuts down the runtime and is not executed
  by `commands:audit`. Its confirmation-gated UI path is inspected, not run.
- **Simulation warnings observed, not fixed this round:**
  `home storage failed: pathfinder reported success but the bot is not within
  3 blocks of the destination`, repeated `BUILD_PHASE produced no verified
  result`, and occasional multi-second event-loop blocks during
  `CHOP_WOOD`/`MINE_ORE`. These are recorded as simulation/runtime findings,
  not presented as fixed.
- **Raw semantic failures** (for example an unknown mine target) still return a
  200 command record with `result.ok:false`; contract failures (`ARGS`,
  `UNKNOWN_COMMAND`) return 400. This preserves command history and the
  dashboard’s two-step confirmation flow; it is documented rather than hidden.
- **Metadata confirmation is primarily an operator pre-prompt.** The handlers
  remain the authority for the destructive actions exercised here
  (`build`, `build stop`, `build run`, `build repair`, `excavation`,
  `storage`, `target`). A future command that only adds metadata
  `confirmSubcommands` will not become backend-gated by implication.

### J. Git status

- Branch: `arena/de11bd2d-chickenbots`
- Code commit: `2dd6e56` (23 files changed, 1912 insertions, 157 deletions)
- Push: `e13e50a..2dd6e56` pushed to `origin/arena/de11bd2d-chickenbots`
- Working tree after the code commit: clean except this report file, which is
  committed separately.
- No credentials, tokens, generated schematics or `.env` files were committed.
