# Chickenbots V6 — authentication report (rounds 34–36)

**Status: unit/simulation evidence only. No AuthMe, SimpleAuth or live login was
run from this sandbox.**

The authoritative profile table and configuration are in
`AUTHENTICATION_PROFILES.md`. This report records the safety properties enforced
by the code and the tests that prove them.

## Defaults and rules

- Default profile is `none`: no `/login` or `/register` is sent.
- `offline` is an explicit opt-in for servers that permit offline mode. It is
  never inferred from a failed online login.
- `authme`/`simpleauth` require an observed challenge before a password command.
  A challenge timeout returns `AUTH_PROMPT_TIMEOUT` and sends nothing.
- AuthMe and SimpleAuth now have distinct registration defaults: AuthMe asks for
  the password twice, SimpleAuth uses its single-password form. Either can be
  overridden with `MC_AUTH_LOGIN_TEMPLATE` / `MC_AUTH_REGISTER_TEMPLATE`; both
  are rejected at configuration time unless they contain `{password}`. Passing
  the legacy generic command no longer silently erases the selected profile's
  form.
- `manual` keeps the socket open but gates gameplay until the operator acts.
- `generic` exists for legacy parser compatibility; runtime configuration should
  use a named profile.
- Unknown profiles fail configuration validation. Legacy boolean auth cannot be
  combined with an explicit profile.
- `MC_AUTH_MAX_ATTEMPTS` is clamped (1–5), so a wrong password is not retried
  forever.
- Permanent failures (`AUTH_REJECTED`, `AUTH_NOT_REGISTERED`,
  `AUTH_MISSING_CREDENTIAL`, `AUTH_PROMPT_TIMEOUT`, and `AUTH_FAILED` with a
  rejection message) pause automatic reconnects until an explicit dashboard
  reconnect. Transient network failures still recover on the reconnect schedule.
- Registration is opt-in. A "not registered" reply never creates an account
  unless `MC_AUTH_REGISTRATION_ENABLED=true` and a registration password exists.
- Passwords are redacted from commands, errors and logs. Credentials come from
  environment variables or an ignored credentials file; `check:secrets` passes
  over 214 tracked files.

## Evidence

`tests/plugin-compat.test.js` covers:

- profile validation and fail-closed unknown profiles;
- connection-auth override semantics;
- prompt classification that ignores ordinary chat;
- command construction/redaction;
- challenge timeout with zero commands sent;
- exactly one login command after a matched challenge and confirmation;
- bounded attempts;
- prompt-waiter abort on socket close;
- permanent-vs-transient retry classification;
- no auto-registration when disabled;
- no password echoed into an error result;
- AuthMe confirmation and SimpleAuth single-password registration forms;
- per-server template override reaching the live profile.

## Not verified

- No real AuthMe/SimpleAuth challenge, success, wrong-password lockout or
  registration was exercised.
- No live reconnect after a successful authentication was observed.
- No Floodgate/Bedrock identity test exists; see `PLUGIN_COMPATIBILITY.md`.

Run the live checklist in `LIVE_ACCEPTANCE_REPORT.md` on a host that can reach
the server before marking any authentication criterion PASS.
