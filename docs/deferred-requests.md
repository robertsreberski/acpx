# Deferred requests

An agent stops mid-turn whenever it needs something only a person can give it:
permission to run a command, or an answer to a question. By default acpx settles
that itself — approve, deny, or prompt a TTY — and the turn moves on.

`--defer` changes the answer to "not yet". The request is **parked**: the turn
stays blocked, a durable record is written under `~/.acpx/requests/`, and the
request waits for [`acpx <agent> respond`](CLI.md#respond-command). Nothing is
approved and nothing is denied in the meantime.

That makes acpx usable as the agent half of a system where the human is
somewhere else entirely — a chat bot, a ticket queue, a pager — because the
question survives the process that asked it.

## The two kinds

| Kind          | The agent is asking       | Answered with                                          |
| ------------- | ------------------------- | ------------------------------------------------------ |
| `permission`  | may I run this tool call? | `--option`, `--decline`, `--cancel`                    |
| `elicitation` | fill in this form         | `--accept`/`--field`/`--text`, `--decline`, `--cancel` |

Both park identically: same store, same expiry, same unwinding, same events,
same gates. Only the question and the shape of its answer differ.

## Lifecycle

```text
                    ┌──────────────────────── respond --option/--field/--text/--accept
                    │                         └─ answered
   agent asks       │
        │           ├──────────────────────── respond --decline
        ▼           │                         └─ answered   (permission: the agent's
   ┌─────────┐      │                             reject option; elicitation: "skipped")
   │ pending │──────┤
   └─────────┘      ├──────────────────────── respond --cancel
        │           │                         └─ cancelled
        │           │
        │           ├──────────────────────── --defer-max-age elapsed
        │           │                         └─ expired
        │           │
        │           └──────────────────────── session cancelled, or owner stopped
        │                                     └─ cancelled
        │
        └───────────────────────────────────── owner died holding it
                                              └─ orphaned
```

`pending` is the only non-terminal state. Every other state is final: a settled
request cannot be answered again, and trying is exit `2`.

- **`answered`** — a real answer reached the agent. `resolution.option_id`
  records which option (permission), `resolution.action` which ACP action
  (elicitation: `accept` or `decline`).
- **`cancelled`** — the request was abandoned rather than answered.
  `resolution.source` says by whom: `cli` (an operator ran `--cancel`), `cancel`
  (the session was cancelled), `shutdown` (the owner stopped).
- **`expired`** — nobody answered in time. **Expiry never approves and never
  accepts**: a permission request falls to the agent's own rejection option, and
  an elicitation declines, which is ACP's "the user skipped this form". Nothing
  is ever invented on the operator's behalf.
- **`orphaned`** — the queue owner holding the request died. The waiter died
  with it, so no answer can land. Only a caller that can _prove_ the owner is
  gone marks this: the session's next queue owner (its generation is the proof),
  or `respond` after finding no live owner. `requests` never does — an owner
  that is merely slow looks identical from outside, and rewriting its entries
  would destroy answers that are still coming.

Terminal entries are pruned after **7 days** by the next owner's startup sweep,
and the whole directory is deleted when its session is closed or pruned.

## The flow

> **Codex approves its own tool calls unless you tell it not to.** Its default
> `agent` preset runs commands inside its own sandbox and never sends a
> permission request at all, so `--defer` has nothing to park and `requests`
> comes back empty. Set the session to the preset that asks first:
>
> ```bash
> acpx codex set mode read-only     # "Requires approval to edit files and run commands"
> ```
>
> Run that **before the session's first prompt**, and the mode holds for the
> session's lifetime: it is saved on the record and applied to every adapter
> session the record is later bound to. Run it against a session whose queue
> owner is already warm and the next prompt can still self-approve — see the
> hazard below. Every codex example below assumes the mode was set first. Agents
> that do not sandbox their own tool calls — `claude`, for one — need nothing
> extra.

> **Setting the mode on an already-warm session does not take effect on the next
> prompt.** A queue owner that is warm but between turns keeps the adapter
> session it used last, and it does not apply `set mode` to it — the change goes
> to a throwaway connection, is saved on the record, and the next prompt runs on
> the retained session at the **old** mode. For codex that means the `agent`
> preset is still in force: it approves its own tool calls, `--defer` has nothing
> to park, `requests` comes back empty, and the command has already run. It is
> the same end state a queue-owner restart used to produce, reached from the
> other direction.
>
> Nothing reveals the discrepancy from outside: `status` reports owner health,
> not the session's mode, and the mode on the session record is the value the
> adapter last reported, not the one in force. Follow one of these instead of
> polling for it:
>
> - **Set the mode before the first prompt (preferred).** With no owner running,
>   the mode is saved on the record and the first owner re-applies it when it
>   binds its adapter session.
> - **On a session that is already warm, retire the owner before the next
>   prompt** — `acpx codex sessions close`, or let its idle TTL lapse (`--ttl`,
>   default 300s). The next prompt rebinds and re-applies the saved mode. Answer
>   or cancel anything parked first: closing a session deletes its requests.

The mode also survives owner restarts as of `0.13.0-fork.2`. A session's mode is
saved on its record and re-applied whenever `acpx` binds that record to a fresh
adapter session: a queue owner that died and was respawned, an agent process
that exited, a `session/resume` that fell back to `session/load` or
`session/new`. Before that the mode was applied only to the connection that set
it, so the next owner started the session at the adapter's own default —
`agent` for codex, `auto` for claude, both of which approve their own tool
calls — and a session that had been parking every write silently regained
self-approval. If an adapter refuses the saved mode (an upgrade retired the id),
the turn still runs and the refusal is reported as an `_acpx/warning` carrying
`code: SESSION_MODE_NOT_REAPPLIED`, so a poller can see the mode is not in
force rather than assuming it is.

```bash
# 0. Make codex ask before it acts, before the session's first prompt
#    (see the notes above — on an already-warm session this needs an owner
#    restart to take effect).
acpx codex set mode read-only

# 1. Ask, and do not wait for the answer.
acpx --defer --policy '{"defaultAction":"defer"}' codex prompt --no-wait 'run the repo checks'

# 2. See what is waiting.
acpx codex requests --json

# 3. Answer it. The blocked turn resumes as soon as this lands.
acpx codex respond <request-id> --option allow
```

`--no-wait` is what makes this useful: it returns as soon as the queue owner has
accepted the prompt, leaving the owner holding the turn. The answer can come
minutes or hours later, from a different shell or a different process.

### What an agent's options actually look like

The option list is stored and listed **verbatim**, because only the agent knows
what its ids mean. Two things that surprises people:

- **There may be no rejection option.** Codex offers `allow_once`,
  `allow_always`, `accept_execpolicy_amendment` (a second allow, naming the
  command prefix it would whitelist) and `reject_once` — but no
  `reject_always`. `--decline` answers with whichever rejection the agent
  offered, and is **refused** when it offered none rather than being downgraded
  to a cancel, which is a different outcome for the agent.
- **The title may be empty.** Codex sends none, so the listing shows acpx's
  `tool` fallback and the tool call's `raw_input` is where the actual command
  is. Read `raw_input` when the title tells you nothing.

## `--defer` and `--defer-max-age`

Both are **owner-level**: they are fixed when the session's queue owner process
starts, and every later submit runs against that owner.

- `--defer` parks `defer`-matched permission requests. Without it, a `defer`
  policy match degrades to a denial for the turn (and still emits a
  `_acpx/permission_escalation` event), because there is nothing to park with.
- `--defer-max-age <seconds>` bounds how long a request waits. Default `86400`.
  **`0` never expires**, and an entry parked indefinitely carries no
  `expires_at` at all.

A submit a warm owner cannot honour is **refused**, never silently downgraded:

| Situation                                                    | Result                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| `--defer` submitted to an owner started without it           | exit `1`, `detailCode: "QUEUE_OWNER_PARKING_UNSUPPORTED"` |
| `--defer-max-age` differs from the owner's **effective** age | exit `1`, `detailCode: "QUEUE_OWNER_PARKING_UNSUPPORTED"` |

The comparison is against the owner's _effective_ age, not what each side asked
for — otherwise a caller that omitted the flag would silently inherit the
owner's age, and a caller that named the default would be refused by an owner
that merely defaulted to it. Close the session (or let its TTL lapse) so a new
owner starts with the settings you want.

Version skew is handled the same way: an owner whose lease predates the
`queueProtocol` field is treated as legacy and refused a parking submit rather
than being asked to do something it has no code for.

## Elicitation forms

Some agents ask questions instead of asking permission. ACP models that as a
**form elicitation**: the agent sends a JSON Schema of the fields it wants
filled in.

acpx advertises support for form elicitation **only when the owner runs with
`--defer`**, because parking is the only way it can answer one.

- `claude-agent-acp` keeps `AskUserQuestion` in its `disallowedTools` unless a
  client advertises form elicitation, so advertising it is exactly what
  re-enables the tool.
- Advertising it with no answerer behind it would be worse than staying silent:
  the model would start asking questions acpx could only auto-decline.
- An owner started **without** `--defer` therefore advertises nothing and the
  agent keeps its stock behaviour. That is the working default, not a bug.

Because ACP negotiates capabilities per connection, this is a property of the
owner _process_: a prompt submitted without `--defer` to a warm `--defer` owner
can still have its turn park on an elicitation. Parking it is still the right
answer — the alternative is auto-declining a question a human was meant to see.

### Answering a form

```bash
# Assumes `acpx codex set mode read-only` (see the note under "The flow").
acpx codex requests --json                                   # read requested_schema
acpx codex respond <id> --field question_0='Greeting A'      # fill one field
acpx codex respond <id> --field picks=a --field picks=b      # multi-select
acpx codex respond <id> --text 'my own answer'               # one-field sugar
acpx codex respond <id> --accept                             # accept with nothing to say
acpx codex respond <id> --decline                            # the form was skipped
```

Values are coerced by the `type` the agent declared for each field:

| Schema type          | `--field` value                                | Sent as        |
| -------------------- | ---------------------------------------------- | -------------- |
| `string`, or untyped | anything                                       | the string     |
| `boolean`            | `true` or `false`, exactly                     | `true`/`false` |
| `number`             | a JSON number                                  | a JSON number  |
| `integer`            | a whole JSON number                            | a JSON number  |
| `array`              | repeat the flag, or comma-separate (see below) | a string array |

Numbers use **JSON's** grammar, not JavaScript's: `1e3` and `-2.5` are numbers;
`0x1F`, `0o17`, `0b11`, `1_0`, `007` and `+5` are refused with the value echoed
back, because `Number()` would read them as 31, 15, 3, 10, 7 and 5 — values
nobody typed.

**Multi-select.** A `type: "array"` property is an enum of strings. Repeating
the flag is the authoritative form — each occurrence is exactly one value, taken
literally — so a value containing a comma or padded whitespace is reachable
without any escaping. A single occurrence comma-splits as sugar, but only where
that cannot be wrong: if any offered value itself contains a comma or padded
whitespace the comma form is refused and points at the repeated form. Where the
schema lists its values, every item is checked against them, so a split that
could not match is refused rather than delivered.

**`--text`.** Answers a one-field form. It also answers a question paired with
its free-text companion — the "Other" box an AskUserQuestion bridge marks with
`_meta._askUserQuestionCustomAnswer` — routing the answer to the question when
it names one of the offered options (by value or by title) and to the free-text
field when it does not. The marker is matched structurally, so this works for
any bridge that emits it. Anything else is refused, naming the fields.

**`--accept`.** Accepts with whatever `--field` values are given. On its own it
sends empty content, which is the only way to answer a form that declares no
properties. It cannot skip a required field.

Anything that does not fit is a usage error rather than a guess — an ill-typed
value would otherwise reach the agent as a real answer.

## Watching from outside

Every transition is written into the session's event log as a synthetic
JSON-RPC notification. The underscore prefix marks it as a client extension so
an ACP reader can skip it.

| Method                        | When                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `_acpx/pending_request`       | a request parked, or changed state                                                                                            |
| `_acpx/permission_escalation` | a policy `escalate`/`defer` match was reported                                                                                |
| `_acpx/warning`               | a saved mode could not be re-applied, or a listing could not reach a live owner (the listing case is stderr, `--format json`) |

The log is `~/.acpx/sessions/<record-id>.stream.ndjson`, one JSON object per
line, appended as the turn runs. It is the only place these events surface for a
`--no-wait` caller, whose formatter is discarded when the command returns.

The agent-authored bulk is left out of the notification — a permission request's
`raw_input`, an elicitation's `requested_schema` — because both repeat on every
transition and the durable entry already holds them verbatim. Read the entry for
detail; read the log for timing.

Note the log is flushed at turn checkpoints, not synchronously, so a poller that
needs the earliest possible signal should watch the request store instead.

## Status

`acpx <agent> status` reports the session and its owner:

| State         | Meaning                                                            |
| ------------- | ------------------------------------------------------------------ |
| `alive`       | the owner is running and answering                                 |
| `unreachable` | the owner process is alive but its socket did not answer the probe |
| `dead`        | no live owner                                                      |

`unreachable` is deliberately distinct from `dead`: the process still holds
whatever it parked, so `status` reports it and leaves it running. No acpx
command that only reports — `status`, `requests`, the read verbs — ever retires
an owner.

`parkedRequests` counts entries still `pending`, of either kind. It is read from
the durable store rather than from the owner, so it still reports after the
owner is gone — which is exactly when an operator needs it.

## Exit codes

| Code | When                                                                                                                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | answered                                                                                                                                      |
| `1`  | the answer could not be delivered to the queue owner                                                                                          |
| `2`  | usage: no answer flag or more than one, an unknown option id, a value the schema cannot take, or a request that is unknown or already settled |
| `3`  | `--timeout` elapsed (see below)                                                                                                               |
| `4`  | no session for this directory, or the owner that parked the request is gone                                                                   |
| `5`  | a permission was denied (from `prompt`/`exec`, not from `respond`)                                                                            |

`respond` waits indefinitely by default, because an answer already on the wire
may be applied at any moment. A caller that cannot wait passes the global
`--timeout <seconds>`; it then exits `3` with
`detailCode: "PENDING_REQUEST_ANSWER_TIMEOUT"`. The bound covers the whole
operation — reaching the owner as well as waiting for its confirmation — and the
message says which ran out:

- **the owner was reached** — the answer may still be applied afterwards. Treat
  it as unknown rather than failed: **re-read the request** before retrying.
- **the owner could not be reached** — nothing was delivered and the request is
  still parked.

## Recipe: an external controller

Poll for parked requests, relay them wherever the human is, and answer. This is
the shape a chat bot or ticket integration takes.

```bash
#!/usr/bin/env bash
# Relay parked requests to a human and answer them. Runs anywhere the acpx
# session directory is reachable.
set -euo pipefail

AGENT=${AGENT:-codex}

while :; do
  # --all covers every session and needs no session in the current directory.
  acpx "$AGENT" requests --all --json | jq -c '.[] | select(.state == "pending")' |
  while read -r entry; do
    id=$(jq -r '.request_id' <<<"$entry")
    kind=$(jq -r '.kind' <<<"$entry")

    if [ "$kind" = "elicitation" ]; then
      question=$(jq -r '.elicitation.message' <<<"$entry")
      fields=$(jq -r '.elicitation.requested_schema.properties | keys | join(", ")' <<<"$entry")
      answer=$(ask_human "$question (fields: $fields)")          # your transport
      acpx "$AGENT" respond "$id" --text "$answer" --timeout 30
    else
      title=$(jq -r '.tool_call.title' <<<"$entry")
      options=$(jq -r '[.options[].option_id] | join(", ")' <<<"$entry")
      choice=$(ask_human "$title — allow? ($options)")           # your transport
      acpx "$AGENT" respond "$id" --option "$choice" --timeout 30
    fi
  done
  sleep 5
done
```

Points that matter in a real controller:

- **Bind to the JSON, not the text.** `requests --json` prints the persisted
  store entries verbatim — snake_case, `acpx.pending_request.v1` — and that
  shape is shared by the files on disk, the queue wire, and this listing.
- **Answer from the session's `cwd`.** The JSON carries it. `respond` resolves
  the session by directory (or by `-s <name>`), so a controller handling
  `--all` must `cd` there or pass the name.
- **`--timeout` on `respond`, and re-read on exit `3`.** A controller cannot
  block forever on one answer, and exit `3` is "unknown", not "failed".
- **Treat exit `4` as terminal for that request.** The owner is gone; the entry
  is `orphaned` and no answer will ever land.
- **Expect the answer to be late.** Between listing and responding the request
  may have expired or been cancelled by someone else. That is exit `2`, and it
  is normal.

## Known residuals

Recorded deliberately rather than hidden:

- **Straggler attribution.** A permission request that arrives after the turn
  that provoked it has finished is attributed to the next turn's event-log
  segment. ACP carries no turn id, so there is no key to attribute it by. The
  payload is authoritative instead: every `_acpx/pending_request` event carries
  the owning task in `request.task_request_id`, and the durable entry is
  unaffected. Attribute by that field, not by which segment it landed in.
- **Unbounded control verbs.** `cancel`, `set-mode`, `set model`, `set` and
  `sessions close` pass their `--timeout` to the _owner_, which applies it to
  its own work and then replies. Against an owner that never replies at all,
  those callers have no bound of their own. `respond` and `requests` do.
- **Capability negotiation is per connection.** See the elicitation section: a
  non-`--defer` submit to a warm `--defer` owner can still park an elicitation.
- **`requests` may be short.** It adds what a live owner is holding that the
  store does not know about, waiting at most two seconds. If the owner cannot be
  reached the listing still prints and the gap is reported on stderr — never
  silently.

## See also

- [Permissions](permissions.md) — modes, per-tool policy, and what `defer` matches
- [`requests`](CLI.md#requests-command) and [`respond`](CLI.md#respond-command)
- [Exit codes](exit-codes.md)
