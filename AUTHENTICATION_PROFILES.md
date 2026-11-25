# Chickenbots V6 — authentication profiles

**Default: `MC_AUTH_PROFILE=none`.** No bot sends `/login` or `/register` unless
the operator explicitly chooses a plugin profile and the server prints a
matching challenge.

This pass does not claim that AuthMe or SimpleAuth was tested against a real
server. It implements the profile/state machinery, bounds the retries and adds
unit coverage.

## Profiles

| Profile | Connection auth | Sends chat? | Challenge required | Registration | Use |
|---|---|---|---|---|---|
| `none` | `MC_AUTH` (`offline`/`microsoft`) | never | — | no | default |
| `offline` | offline | never | — | no | server explicitly allows offline mode |
| `microsoft` | Microsoft | never | — | no | normal authenticated Java account |
| `manual` | as configured | never | yes | no | operator authenticates manually; socket stays open and gameplay is gated |
| `authme` | offline/microsoft as configured | yes | **yes** | opt-in | AuthMe prompt observed |
| `simpleauth` | offline/microsoft as configured | yes | **yes** | opt-in | SimpleAuth prompt observed |
| `generic` | as configured | yes | optional | opt-in | explicit operator templates; used by legacy parser tests |

`generic` is proactive for backwards compatibility with the isolated parser
tests. Runtime configuration should use `authme`/`simpleauth`/`manual`.

## Configuration

```text
MC_AUTH_PROFILE=none
MC_AUTH_REGISTRATION_ENABLED=false
MC_AUTH_MAX_ATTEMPTS=2
MC_AUTH_RETRY_DELAY_MS=1500
MC_CREDENTIALS_FILE=.mc-auth.json
MC_LOGIN_COMMAND=/login {password}
MC_REGISTER_COMMAND=/register {password} {password}
```

`MC_AUTH_MAX_ATTEMPTS` is clamped to 1–5. A validation failure prevents startup;
a wrong credential is not retried forever.

Per-bot credentials are read from an ignored JSON file:

```json
{
  "________": { "password": "replace-me" },
  "10101000": { "password": "replace-me", "registerPassword": "replace-me" }
}
```

The file is parsed at startup. Parse errors are reported without printing file
contents. Every value is included in the central redaction set, alongside the
legacy fleet password and dashboard token.

## Flow

1. Connect with the configured offline/Microsoft mode.
2. Complete protocol login and spawn.
3. If the profile needs a challenge, record the server prompt and wait up to
   `MC_AUTH_TIMEOUT_MS`.
4. If no prompt is observed, return `AUTH_PROMPT_TIMEOUT` **without sending a
   password**.
5. If a prompt is observed, check that a credential exists. Missing credential
   returns `AUTH_MISSING_CREDENTIAL`.
6. Send the profile command once, up to the bounded attempt count.
7. Mark authenticated only after a success line. Wrong password, lockout,
   “not registered” and unknown-command responses are classified as failures.
8. Registration is only attempted when `MC_AUTH_REGISTRATION_ENABLED=true` and
   the profile has a registration template. A `not registered` login reply does
   not silently auto-create an account when registration is off; it returns
   `AUTH_NOT_REGISTERED`.
9. Permanent auth outcomes (`AUTH_REJECTED`, `AUTH_NOT_REGISTERED`,
   `AUTH_MISSING_CREDENTIAL`, `AUTH_PROMPT_TIMEOUT`) pause the supervisor. A
   dashboard reconnect is required after the operator fixes the cause. A
   transient confirmation timeout (`AUTH_TIMEOUT`) still retries with backoff.

A `manual` profile returns a pending result: the socket remains open, no command
is sent, `authRequiredManual` is set, and the autonomy gate stays closed.

## Security invariants

- No automatic `/login` or `/register` with the default profile.
- No password in logs, error strings, diagnostics or the dashboard.
- No credential in Git; `.mc-auth.json` is ignored.
- No retry beyond the configured cap.
- No bypass of a captcha, ban, whitelist or moderator decision.
- Registration is not a default action.

## Evidence

`tests/plugin-compat.test.js` covers: profile resolution, unknown-profile
rejection, template validation, prompt/success/failure classification, bounded
attempts, missing challenge, successful challenge response, manual pending state,
capability confidence and per-bot redaction.

Not verified: a live AuthMe server, live SimpleAuth version differences, plugin
lockout wording, and a live Microsoft-authenticated session.
