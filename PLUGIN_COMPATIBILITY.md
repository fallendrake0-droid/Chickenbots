# Chickenbots V6 — plugin compatibility

**No plugin was tested against a live server in rounds 34–36.** The arena sandbox
cannot reach the target host. This document separates what the client can
actually observe from what an operator configured; it does not claim plugin
certification.

## Edition and transport

Chickenbots is a **Java Edition** client. Native Bedrock transport is not
implemented: capability detection reports `NOT_SUPPORTED` and the explicit error
`BEDROCK_TRANSPORT_NOT_IMPLEMENTED`. A Geyser/Floodgate server may still be
reachable through its **Java** port; that is a Java connection, not a Bedrock
one, and the client does not infer Geyser from it.

## Detection matrix

| Capability | How it is reported | Confidence | Notes |
|---|---|---|---|
| Paper, Folia, Purpur, Spigot, Bukkit, Fabric, Forge, Vanilla | `detectServerSoftware(brand)` matches the server brand string | `DETECTED` only when a brand was received | An absent brand is `UNKNOWN`, never guessed |
| Velocity / BungeeCord / Waterfall | Proxy object only when the brand itself names the proxy | `DETECTED` or `UNKNOWN` | Proxies are not enumerable through the play protocol |
| ViaVersion / ViaBackwards | Always a separate capability object | `UNKNOWN` | Not inferred from the status name; the protocol number reported by the version probe is authoritative |
| Geyser | Separate capability object | `UNKNOWN` | A Java endpoint does not prove Geyser is installed |
| Floodgate | Separate capability object | `UNKNOWN` | Not exposed by the play protocol; no identity is forged |
| AuthMe / SimpleAuth | Configured profile plus a matched challenge | `CONFIGURED`, then `DETECTED` when a prompt is observed | No password is sent without the challenge. AuthMe and SimpleAuth have distinct registration defaults; per-server forms are configurable |
| GrimAC / other anti-cheat | `antiCheat` remains `UNKNOWN` until a kick reason identifies it | `UNKNOWN` / detected from evidence | No bypass, packet forgery, position spoofing or ground-state forgery. Movement is bounded and legitimate; `invalid_player_movement` is treated as a real rejection |
| Geyser Bedrock transport | `bedrock` capability | `NOT_SUPPORTED` unless a Bedrock transport is actually configured | Java client only |

## Client behaviour expected on plugin servers

- **Auth plugin:** `none` by default. `authme`/`simpleauth`/`manual` wait for a
  real challenge before sending `/login`; attempts are bounded; permanent
  failures pause automatic reconnects instead of tripping a lockout. See
  `AUTHENTICATION_PROFILES.md` and `AUTHENTICATION_REPORT.md`.
- **ViaVersion/ViaBackwards:** the client resolves and logs the server's
  protocol and connects with a supported Java version. It does not pretend a
  protocol is supported when it is not.
- **Geyser:** connect to the Java port as a Java account. Bedrock identity,
  Floodgate linking and Bedrock packet behaviour are out of scope.
- **GrimAC:** no evasion. The movement arbiter, pathfinder budget, client-stall
  re-anchor and `invalid_player_movement` strike limit are designed to stop
  sending stale/huge corrections rather than to hide them.
- **Proxy/duplicate sessions:** one socket per username; reconnect closes the
  old socket before a new login; a second runtime is blocked by `liveLock`.

## Test evidence

- `tests/plugin-compat.test.js` — profile validation, distinct AuthMe/SimpleAuth
  registration forms and template overrides, brand-based software detection,
  conservative `UNKNOWN` for Via/Geyser/Floodgate/Grim, Java edition,
  `BEDROCK_TRANSPORT_NOT_IMPLEMENTED` path.
- `tests/connection-lifecycle.test.js` — duplicate-session/reconnect state.
- `tests/protocol-compression.test.js` — inbound decompression off the event
  loop.

## Live checklist (not run)

1. Record the server brand/protocol shown on the Connections page.
2. Confirm AuthMe/SimpleAuth prompt text and that no password is sent before it.
3. Confirm ViaVersion does not produce a protocol-mismatch kick.
4. Confirm Geyser is reached through the Java port and that no Bedrock transport
   is attempted.
5. Confirm zero `invalid_player_movement` kicks during a 30-minute movement soak
   and attach the server log.
