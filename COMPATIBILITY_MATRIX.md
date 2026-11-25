# Chickenbots V6 — compatibility matrix

**Legend:** `PASS-SIM` = deterministic simulation; `PASS-UNIT` = unit test only;
`UNTESTED` = no server available; `NOT_IMPLEMENTED` = no transport/adapter.

A row is never marked PASS-LIVE in this report. The sandbox cannot reach
`EmpiSMP.aternos.me:32990`.

| Target | Connection path | Evidence | Status | Limitations |
|---|---|---|---|---|
| Vanilla Java | Java Mineflayer, version probe | version-resolution unit tests | UNTESTED | no live server |
| Spigot | Java Mineflayer | protocol/lifecycle tests | UNTESTED | no live server |
| Paper | Java Mineflayer | protocol/lifecycle tests | UNTESTED | live movement kick was on Paper-family server |
| Purpur | Java Mineflayer | none | UNTESTED | no server |
| Velocity | Java endpoint through proxy | status branding only | UNTESTED | proxy detection is UNKNOWN unless brand says Velocity |
| BungeeCord | Java endpoint | none | UNTESTED | no server |
| Waterfall | Java endpoint | none | UNTESTED | no server |
| ViaVersion | Protocol-number negotiation | `serverVersion` tests | PASS-UNIT | name is not trusted over protocol |
| ViaBackwards | older client translation | none | UNTESTED | no proxy |
| Geyser Java endpoint | Java Mineflayer | capability reports UNKNOWN | UNTESTED | Geyser not enumerable from play protocol |
| Geyser Bedrock endpoint | native Bedrock | capability reports `NOT_SUPPORTED` | NOT_IMPLEMENTED | Java client must not be pointed at Bedrock UDP |
| Floodgate | identity conventions | capability reports UNKNOWN | UNTESTED | no forgery/bypass |
| AuthMe | `authme` profile | `plugin-compat.test.js` | PASS-UNIT | no live AuthMe; syntax may vary |
| SimpleAuth | `simpleauth` profile | `plugin-compat.test.js` | PASS-UNIT | version-specific syntax unverified |
| Generic chat auth | `generic` profile | parser tests | PASS-UNIT | operator must supply exact templates |
| Manual auth | `manual` profile | pending-auth test | PASS-UNIT | no operator UI action to confirm |
| GrimAC | legitimate client movement | round-26 packet tests | UNTESTED | no anti-cheat server |
| Other anti-cheat | correct packets only | round-26 tests | UNTESTED | kick reason only, never a bypass |
| Unknown plugin | conservative fallback | capability test | PASS-UNIT | reported UNKNOWN, not guessed |

## Version facts

- Configured client default: `MC_VERSION=auto`, resolved by status probe.
- Last observed live server name: `26.1`, protocol `775`.
- `minecraft-data`/`minecraft-protocol` support is validated before login.
- The status name is not trusted over the protocol number.
- No claim is made for 26.3/776/777.

## Native Bedrock

There is no Bedrock transport in this repository. `detectCapabilities()` returns
`NOT_SUPPORTED` for Bedrock and `edition: 'java'`. Pointing the Java client at a
Geyser Bedrock UDP port is not a supported workaround.
