# Chickenbots

Five independent Mineflayer clients and a local control centre with operator-requested work orders. No AI, API keys or anti-AFK evasion. Default target: **cr3xlol.aternos.me:55742**. Only a Mineflayer `spawn` event counts as connected; server-plugin authentication is a separate state.

## Requirements and installation

Node.js **22 or later**, npm, and permission from the server owner. Mineflayer implements the Minecraft Java protocol; it is not a Minecraft launcher. Aternos must be started normally in its control panel. This project cannot start it. The server must have room for all five players.

Linux / Chromebook Debian (install Node.js 22+ using your distribution or a trusted Node.js installer):

```sh
git clone --branch arena/89d4431b-chickenbots https://github.com/fallendrake0-droid/Chickenbots.git
cd Chickenbots
npm install
npm start
# Press E to configure, then Enter to start.
```

Termux: `pkg update && pkg install nodejs git`, then run the Linux commands above. Check `node -v` is at least 22; some devices or native dependencies may not be supported.

Windows PowerShell (install Node.js 22+ and Git first):

```powershell
git clone --branch arena/89d4431b-chickenbots https://github.com/fallendrake0-droid/Chickenbots.git
cd Chickenbots
npm install
npm start
# Press E to configure, then Enter to start.
```

At the startup screen, press **E** to edit configuration, or press **Enter** to start. Enter the shared server-plugin password at the hidden prompt, or set `BOT_AUTH_PASSWORD` in the untracked `.env` or shell environment. All five accounts use that configured value. No default password is shipped; the previously published shared password is compromised and remains in Git history, so an administrator should change it on the server. The plugin password is **not** a Microsoft password. Do not commit `.env` or share `data/`. On non-interactive input, configure the password before starting. Open **http://127.0.0.1:3000** locally. The dashboard has no separate user login; anyone with access to your local machine can control it.

## Minecraft account authentication

`MC_AUTH=offline` is the default for servers that explicitly permit offline identities. This does not bypass online-mode authentication; never impersonate another player. If an existing `.env` still sets `MC_AUTH=microsoft`, press E at startup and change it to `offline` only if the server permits it.

`MC_AUTH=microsoft` is available for online-mode servers. Follow each bot's device-login instructions in the terminal, using the legitimate Microsoft account that owns that Minecraft Java profile. Five simultaneous premium identities require five distinct eligible accounts with the exact configured profile names. Microsoft authentication determines the real profile name; it cannot create or impersonate these names. Tokens are cached separately under `data/microsoft/`. Keep the data directory private. If authorization takes longer than 30 seconds, raise `CONNECTION_TIMEOUT` before starting.

Offline identities must be authorized for use on the server. There is no automatic downgrade from Microsoft authentication. The fixed identities are `______`, `101010`, `010101`, `110011`, `001100`; `BOT_NAMES` must preserve exactly these names and order. An administrator must whitelist each actual account if required.

## Server plugin registration

After spawning, each bot waits for a server message requesting registration or login. It sends one `/register` or `/login` command using `BOT_AUTH_PASSWORD`, then waits for a matching server success response; sending alone is not success. An already-registered response to registration switches to login. Wrong-password responses and authentication timeouts stop automatic retries. Registration confirmation is saved independently to `data/auth-state.json`; it is local bookkeeping, not proof of current login. Server prompts remain authoritative, allowing recovery when local state is stale. If the plugin doesn't prompt, or uses different wording, the bot times out rather than guessing or sending credentials prematurely.

Configure case-insensitive JavaScript regular expressions with `AUTH_PATTERN_REGISTER`, `AUTH_PATTERN_LOGIN`, `AUTH_PATTERN_REGISTERED`, `AUTH_PATTERN_SUCCESS`, `AUTH_PATTERN_ALREADY`, `AUTH_PATTERN_INCORRECT`, and `AUTH_PATTERN_INVALID` in `.env`; see `src/config.js` for defaults. `AUTH_TIMEOUT` is milliseconds (default 30000). Confirm these patterns against trusted plugin messages before use. If the server resets accounts, stop the application and delete `data/auth-state.json` only after consulting the administrator; this does **not** reset server accounts or passwords. Restart to follow the server prompts again. Set `BOT_AUTH_ENABLED=false` only if the server does not require this plugin.

## Controls

The dashboard displays actual bot states, position, health, food, ping when available, errors and retries. Start/stop/restart/reconnect operate on real instances; bulk destructive actions ask for confirmation. Hold movement buttons to send Mineflayer control states and release to stop; disconnecting the dashboard clears held controls. Chat is manual, limited to connected and authenticated bots, and cannot send commands. The event stream and selected bot chat are bounded in memory. The application does not interpret player messages as local commands.

Press E at startup, or run `npm run config` to edit settings interactively before starting, even if no `.env` exists. While the application is running, enter `config` in the terminal to open the same editor. Press Enter to keep each value, or type `!clear` to clear it. Password input is hidden. The editor validates all settings and saves them to the private `.env` only when complete; changes made at startup apply when you press Enter, while changes made during operation require a restart. Shell environment variables override `.env`, and fields with an override are labelled. Ctrl-C cancels editing (and shuts down a running app). A real interactive terminal is required. The five names and localhost dashboard binding remain fixed.

The terminal uses colour on supported interactive terminals and plain output when piped. Set `NO_COLOR=1` to disable colour. Live messages preserve the command prompt; messages arriving during the config editor are shown after editing.

Terminal commands: `help`, `config`, `status`, `server`, `ping`, `start [bot|all]`, `stop [bot|all]`, `reconnect [bot|all]`, `chat <bot> <message>`, `clear`, and `exit`. Ctrl-C or SIGTERM also shuts down. The dashboard stays available while bots are offline.

## Work orders and auto-eat

The local dashboard has a **Work orders** section. Choose one connected and server-authenticated bot, or **ALL AVAILABLE BOTS** for a team job, then confirm **Chop nearby trees**, **Mine nearby stone**, or **Mine nearby dirt**. Each order searches loaded blocks within 16 blocks and attempts up to 32 matching blocks. **Excavate** accepts two inclusive integer X/Y/Z corners, each within 48 blocks of the bot, and at most 256 total blocks. It only digs naturally occurring stone, dirt, logs, sand, gravel, clay, and ores; containers, liquids, unbreakable blocks, other materials, unloaded chunks, and the block directly under the bot are skipped. The bot must have a safe path to targets. These are limited work orders, not continuous mining; they do not collect dropped items automatically.

For team jobs, the dashboard builds one deduplicated queue and gives each block to at most one worker at a time. Available authenticated bots in the first eligible bot's dimension participate; offline bots and bots in other dimensions are listed as excluded. Stop existing individual jobs and wait for eating to finish before starting a team job. If a bot fails or disconnects, its unfinished assignment is returned to the queue for the remaining workers; unavailable or unreachable blocks and failures produce a partial result. Team excavation uses the same 256-block limit and its corners must be within 48 blocks of the first eligible bot. Nearby team jobs combine up to 32 candidates per participating bot. **Stop work** with the team selected stops the whole group; selecting a single bot and stopping it removes that worker from the team. You can monitor the shared progress and per-bot actions in the dashboard. These controls coordinate block assignments, not collision-free movement or tool and item sharing.

Bots use the fastest suitable tool already in their inventories; materials such as stone requiring a pickaxe fail with an explanatory status if the appropriate tool is missing. Pathfinder may walk and jump to blocks but is configured not to break or place blocks while navigating. Pathfinding and digging may still be blocked by terrain, server permissions, lag, plugins, or hazards. Use work orders only where you are authorized to modify blocks. Stop the task with **Stop work**, or stop/disconnect the bot; tasks never resume automatically after a disconnect. The selected bot's action progress or error appears in the dashboard; a completed client-side dig is not proof that a server with protection plugins accepted the change. Manual movement is blocked during a work order.

Auto-eat is enabled per bot by default and can be toggled from the work panel. When food is 14 or lower, an authenticated bot selects safe food from its inventory, equips and consumes it, including between work blocks. It does not craft food or tools. If no appropriate food is available it logs a warning and retries at a limited rate; disabled and disconnected bots do not eat. Food and tools must be supplied by the player. Server-side food rules and inventory state can still prevent eating.

## Configuration and troubleshooting

`.env.example` lists defaults. Environment variables override `.env`. `MC_HOST` and `MC_PORT` can be changed without source edits. `MC_VERSION=auto` reads the server status protocol and chooses a matching version supported by the installed `minecraft-protocol`; the server's advertised name and protocol and chosen client protocol are logged. If the server advertises an unsupported protocol but explicitly supports another client via ViaVersion/ViaBackwards, set `MC_VERSION` to a version supported by the installed library and the server. ViaVersion supports newer clients on older servers; ViaBackwards supports older clients on newer servers; ViaRewind adds older 1.7/1.8 support. Server plugins do not make unsupported Mineflayer protocols available. Minecraft status responses and plugin compatibility may vary; a status check cannot prove a join will work.

DNS errors mean the hostname could not resolve; refused or timed-out connections often mean the server is stopped, starting, or unreachable. Start it in Aternos and verify the exact port. Authentication errors require fixing the Minecraft account or plugin password; whitelist/ban errors require administrator action. A reset (`ECONNRESET`, `EPIPE` or `socketClosed`) is a closed network connection, not proof of an authentication or version failure. If it happens shortly after spawn, check the Aternos server console for the same timestamp, login-plugin prompts/timeouts, proxy or anti-bot rules, and the real server version. The log's advertised name and numeric protocol matching an installed client do not prove compatibility. Only the server administrator can diagnose and change server-side restrictions.

Full servers and transient failures retry with per-bot 5, 10, 20, 40, then 60-second backoff. A brief spawn no longer resets the retry counter: the connection must remain authenticated (or have plugin authentication disabled) for `POST_AUTH_STABILITY_MS` (default 30000 ms). `RECONNECT_MAX_ATTEMPTS=0` means unlimited transient retries; `RECONNECT_ENABLED=false` disables them. A server **connection throttled** kick pauses all bot login attempts for at least `THROTTLE_COOLDOWN` (default 30000 ms), even when the normal backoff cap is shorter; do not try to bypass the server limit. `BOT_START_DELAY` remains at least 5000 ms between bot logins; increase it in the config editor if the server still throttles. The status probe is shared across bots and cached briefly; it is not repeated as a separate TCP probe for each bot. A cached status response is not proof of a successful join. `CONNECTION_TIMEOUT` bounds the network status and login/spawn waits. `LOG_LEVEL=debug` permits debug logging and optional `LOG_FILE` appends logs. Keep logs private.

Run `npm test` for mocked lifecycle/authentication tests and local Socket.IO tests. These tests do not prove live Minecraft connectivity, Microsoft ownership, or compatibility with a particular plugin's text. No password or token should be sent through dashboard chat; use the protected configuration instead. Redaction is best-effort and cannot guarantee protection against transformed secrets in third-party errors.

### V3 survival foundation (partial)

Auto-eat selects from an explicit safe-food allowlist using hunger deficit, food value and a configurable priority. The default threshold is 14, reserve is 0 and priority is `balanced`; `cheap` favours preserving expensive food and `saturation` favours saturation. A reserve is protected except when hunger is 6 or below. This is a simple heuristic, not an inventory replenishment system. Auto armour equips available standard vanilla armour only when it is a conservative upgrade: existing enchantments are preserved, binding curses and unknown/special equipment are left alone, and near-broken candidates are rejected. Equipment swaps wait for work/eating and vice versa; open inventory windows pause these idle actions. A swap already in progress cannot necessarily be cancelled by turning the setting off.

The dashboard's **Food & armour** panel uses the bot selector in Work orders. It displays known equipped pieces and a limited observation of nearby hostile entities; this is not a threat assessment or combat system. Set one bot or all bots using the controls, or use `survival <bot|all> armour on|off`, `survival <bot|all> eat on|off`, and `survival <bot|all> food <0-19> <reserve> <balanced|saturation|cheap>` in the terminal. Settings are in memory only and reset on process restart. Armour and auto-eat default on; they use server inventory actions and should only be used where allowed.

This is **not a complete V3 implementation**. Autonomous hazard avoidance, crafting/resource planning, PvE/PvP, fall clutching, schematic catalog/validation, block placement and cooperative building remain unimplemented. Nearby entity names are an incomplete fixed list and may not match every server version. Existing gathering is operator-started and bounded, not an autonomous survival loop. Tests use mocked Minecraft actions; no live-server gameplay verification is claimed.

### Connection investigation and diagnostic scheduling

The supplied logs show four server authentication success messages followed by transport closure, and a separate password rejection for `101010`. Inspection found no call to close or replace the active bot on authentication success; cleanup does close sockets after a failure, timeout, or operator/shutdown request. This does not prove which endpoint initiated the observed resets. The first event is recorded as a kick, or as `DISCONNECT_SOURCE_UNKNOWN` when no kick reason is available. TCP errors do not prove a server-side cause. Correlate each bot's timestamps with Aternos console messages, login-plugin logs, protection rules, and proxy/backend version settings. Do not share credentials or public IPs. For `101010`, verify the exact sanitized server message, the configured environment source and the plugin's account record with the administrator; do not reset or guess a password automatically.

Automatic version selection uses the status protocol number, not the advertised text. In the installed dependencies, client 26.1 supports protocol 775 and 26.3 is not supported. A status label of Spigot 26.3 with protocol 775 is therefore a discrepancy, not proof of the backend version or compatibility; a proxy or translation layer is only a possibility. The sandbox status attempt returned EPIPE, so no raw live status or server-side trace was captured. No live five-bot stability or auth claims are made.

`BOT_START_DELAY` remains a minimum of 5000 ms between actual attempts. `MAX_SIMULTANEOUS_LOGINS` defaults to 1 and holds a login slot until the bot has stayed authenticated for `POST_AUTH_STABILITY_MS` (default 30000 ms), or until it disconnects/fails. Therefore actual join spacing may be longer than five seconds. A bot that repeatedly disconnects before reaching that interval suspends automatic retries at `POST_AUTH_RESET_LIMIT` (default 3); an explicit start/reconnect resets the circuit. The dashboard can also suspend reconnects manually. Other bots continue. Stability means only that no disconnect was observed during the interval, not proof of gameplay compatibility. These settings may be adjusted with the config editor and take effect on restart.
