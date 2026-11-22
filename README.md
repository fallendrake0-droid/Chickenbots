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

At the startup screen, press **E** to edit configuration, or press **Enter** to start. All five bots use the shared default server-plugin password `chickenbot12345` when `BOT_AUTH_PASSWORD` is unset or empty. This default is public and weak; anyone can read it, so ask the server administrator to change the server account passwords and set a private `BOT_AUTH_PASSWORD` in the config editor or untracked `.env` when possible. A previously saved non-empty password or shell environment variable takes precedence over the default. Password typing in the editor is hidden. Never commit `.env` or share `data/`. This plugin password is **not** a Microsoft password. On non-interactive input, startup skips the menu and validates settings immediately. Open **http://127.0.0.1:3000** on the same computer. The local dashboard is intentionally inaccessible from other devices; SSH port forwarding can be used if you understand its security implications. It has no separate user login, so anyone with access to your local machine can control it.

## Minecraft account authentication

`MC_AUTH=offline` is the default for servers that explicitly permit offline identities. This does not bypass online-mode authentication; never impersonate another player. If an existing `.env` still sets `MC_AUTH=microsoft`, press E at startup and change it to `offline` only if the server permits it.

`MC_AUTH=microsoft` is available for online-mode servers. Follow each bot's device-login instructions in the terminal, using the legitimate Microsoft account that owns that Minecraft Java profile. Five simultaneous premium identities require five distinct eligible accounts with the exact configured profile names. Microsoft authentication determines the real profile name; it cannot create or impersonate these names. Tokens are cached separately under `data/microsoft/`. Keep the data directory private. If authorization takes longer than 30 seconds, raise `CONNECTION_TIMEOUT` before starting.

Offline identities must be authorized for use on the server. There is no automatic downgrade from Microsoft authentication. The fixed identities are `______`, `101010`, `010101`, `110011`, `001100`; `BOT_NAMES` must preserve exactly these names and order. An administrator must whitelist each actual account if required.

## Server plugin registration

After spawning, each bot waits for a server message requesting registration or login. It sends one `/register` or `/login` command using `BOT_AUTH_PASSWORD`, then waits for a matching server success response; sending alone is not success. An already-registered response to registration switches to login. Wrong-password responses and authentication timeouts stop automatic retries. Registration confirmation is saved independently to `data/auth-state.json`; it is local bookkeeping, not proof of current login. Server prompts remain authoritative, allowing recovery when local state is stale. If the plugin doesn't prompt, or uses different wording, the bot times out rather than guessing or sending credentials prematurely.

Configure case-insensitive JavaScript regular expressions with `AUTH_PATTERN_REGISTER`, `AUTH_PATTERN_LOGIN`, `AUTH_PATTERN_REGISTERED`, `AUTH_PATTERN_SUCCESS`, `AUTH_PATTERN_ALREADY`, and `AUTH_PATTERN_INCORRECT` in `.env`; see `src/config.js` for defaults. `AUTH_TIMEOUT` is milliseconds (default 30000). Confirm these patterns against trusted plugin messages before use. If the server resets accounts, stop the application and delete `data/auth-state.json` only after consulting the administrator; this does **not** reset server accounts or passwords. Restart to follow the server prompts again. Set `BOT_AUTH_ENABLED=false` only if the server does not require this plugin.

## Controls

The dashboard displays actual bot states, position, health, food, ping when available, errors and retries. Start/stop/restart/reconnect operate on real instances; bulk destructive actions ask for confirmation. Hold movement buttons to send Mineflayer control states and release to stop; disconnecting the dashboard clears held controls. Chat is manual, limited to connected and authenticated bots, and cannot send commands. The event stream and selected bot chat are bounded in memory. The application does not interpret player messages as local commands.

Press E at startup, or run `npm run config` to edit settings interactively before starting, even if no `.env` exists. While the application is running, enter `config` in the terminal to open the same editor. Press Enter to keep each value, or type `!clear` to clear it. Password input is hidden. The editor validates all settings and saves them to the private `.env` only when complete; changes made at startup apply when you press Enter, while changes made during operation require a restart. Shell environment variables override `.env`, and fields with an override are labelled. Ctrl-C cancels editing (and shuts down a running app). A real interactive terminal is required. The five names and localhost dashboard binding remain fixed.

The terminal uses colour on supported interactive terminals and plain output when piped. Set `NO_COLOR=1` to disable colour. Live messages preserve the command prompt; messages arriving during the config editor are shown after editing.

Terminal commands: `help`, `config`, `status`, `server`, `ping`, `start [bot|all]`, `stop [bot|all]`, `reconnect [bot|all]`, `chat <bot> <message>`, `clear`, and `exit`. Ctrl-C or SIGTERM also shuts down. The dashboard stays available while bots are offline.

## Work orders and auto-eat

The local dashboard has a **Work orders** section. Choose one connected and server-authenticated bot, then confirm **Chop nearby trees**, **Mine nearby stone**, or **Mine nearby dirt**. Each order searches loaded blocks within 16 blocks and attempts up to 32 matching blocks. **Excavate** accepts two inclusive integer X/Y/Z corners, each within 48 blocks of the bot, and at most 256 total blocks. It only digs naturally occurring stone, dirt, logs, sand, gravel, clay, and ores; containers, liquids, unbreakable blocks, other materials, unloaded chunks, and the block directly under the bot are skipped. The bot must have a safe path to targets. These are limited work orders, not continuous mining; they do not collect dropped items automatically.

Bots use the fastest suitable tool already in their inventories; materials such as stone requiring a pickaxe fail with an explanatory status if the appropriate tool is missing. Pathfinder may walk and jump to blocks but is configured not to break or place blocks while navigating. Pathfinding and digging may still be blocked by terrain, server permissions, lag, plugins, or hazards. Use work orders only where you are authorized to modify blocks. Stop the task with **Stop work**, or stop/disconnect the bot; tasks never resume automatically after a disconnect. The selected bot's action progress or error appears in the dashboard; a completed client-side dig is not proof that a server with protection plugins accepted the change. Manual movement is blocked during a work order.

Auto-eat is enabled per bot by default and can be toggled from the work panel. When food is 14 or lower, an authenticated bot selects safe food from its inventory, equips and consumes it, including between work blocks. It does not craft food or tools. If no appropriate food is available it logs a warning and retries at a limited rate; disabled and disconnected bots do not eat. Food and tools must be supplied by the player. Server-side food rules and inventory state can still prevent eating.

## Configuration and troubleshooting

`.env.example` lists defaults. Environment variables override `.env`. `MC_HOST` and `MC_PORT` can be changed without source edits. `MC_VERSION=auto` reads the server status protocol and chooses a matching version supported by the installed `minecraft-protocol`; the server's advertised name and protocol and chosen client protocol are logged. If the server advertises an unsupported protocol but explicitly supports another client via ViaVersion/ViaBackwards, set `MC_VERSION` to a version supported by the installed library and the server. ViaVersion supports newer clients on older servers; ViaBackwards supports older clients on newer servers; ViaRewind adds older 1.7/1.8 support. Server plugins do not make unsupported Mineflayer protocols available. Minecraft status responses and plugin compatibility may vary; a status check cannot prove a join will work.

DNS errors mean the hostname could not resolve; refused or timed-out connections often mean the server is stopped, starting, or unreachable. Start it in Aternos and verify the exact port. Authentication errors require fixing the Microsoft account or plugin password; whitelist/ban errors require administrator action. Full servers and transient failures retry with per-bot 5, 10, 20, 40, then 60-second backoff. `RECONNECT_MAX_ATTEMPTS=0` means unlimited transient retries; `RECONNECT_ENABLED=false` disables them. All connection attempts are globally staggered by at least `BOT_START_DELAY` (minimum/default 5000 ms), including retries; queueing may add delay. A successful spawn resets the retry counter. Manual reconnect also resets it. `CONNECTION_TIMEOUT` bounds TCP/status/login/spawn waits; `LOG_LEVEL=debug` permits debug logging and optional `LOG_FILE` appends logs. Keep logs private.

Run `npm test` for mocked lifecycle/authentication tests and local Socket.IO tests. These tests do not prove live Minecraft connectivity, Microsoft ownership, or compatibility with a particular plugin's text. No password or token should be sent through dashboard chat; use the protected configuration instead. Redaction is best-effort and cannot guarantee protection against transformed secrets in third-party errors.
