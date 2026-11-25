# Chickenbots V6 — script and CLI audit

**Executed in this sandbox.** No live server was contacted.

| Command | Actual result |
|---|---|
| `npm test` | **327 passed, 0 failed** |
| `npm run lint` | **LINT PASSED (151 files)** |
| `npm run validate` | **VALIDATION PASSED** (10/10 consistency; tests, lint, schematics, secret check) |
| `npm run deploy:check` | **12/12 checks passed** |
| `npm run check:secrets` | **PASSED** (182 files; values never printed) |
| `npm run schematics:stats` | 10,001 designs; output present |
| `npm run schematics:validate` | not re-run this pass; round-26 audit result retained below |
| `npm run buildings:audit` | not re-run this pass (needs ≥1,050 s); round-26 result below |
| `node src/cli.js --help` | usage printed, exit 0 |
| `node src/cli.js --simulate status` | one-shot status returned 10 bots, then clean `runtime stopped: cli command complete`, exit 0 |

## Round-26 retained audit evidence

- `node scripts/buildings-audit.js`: 10,001/10,001 checked, 0 issues, 0 invalid
  blocks, 0 cycles, 0 failures, 20,001 warnings (version compatibility and
  aggregated unspecified states), 1,028.9 s.
- `npm run schematics:stats`: 10,000 unique designs, 27,821,660 blocks, average
  2,782, largest 79,436, plus 1 custom store design.

These are retained results, not re-executed claims for this pass.

## CLI observations

- The CLI advertises `--simulate` and uses the same command registry as the
  dashboard.
- A one-shot command intentionally shuts its runtime down after returning; this
  is the documented behaviour, not a crash.
- Interactive prompt, Ctrl+C and long-command cancellation were not exercised
  in a TTY because this sandbox has no interactive terminal.

## Remaining script risks

- `npm run schematics:validate` is expensive (~6 minutes) and was not repeated.
- `npm run buildings:audit` is ~17 minutes and was not repeated.
- No cross-platform Windows path test was performed.
