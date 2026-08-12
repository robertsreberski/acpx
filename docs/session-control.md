---
title: Session control
description: cancel, set-mode, set, set model, and status — the verbs that adjust an in-flight or saved acpx session without restarting it.
---

These commands change live session state without restarting an adapter or losing history. They route through the queue owner when one is active, and reconnect directly otherwise.

## `cancel`

```bash
acpx codex cancel
acpx codex cancel -s backend
acpx cancel              # defaults to codex
```

Sends ACP `session/cancel` cooperatively:

- If a queue owner is running, the cancel is delivered through IPC.
- If a prompt is mid-turn, the agent receives `session/cancel`, completes any pending writes, and resolves with `stopReason=cancelled`.
- If nothing is running, `acpx` prints `nothing to cancel` and exits success.

This is the same semantics as `Ctrl+C` during a foreground turn, but available without a TTY signal — useful from scripts and other agents.

## `set-mode`

```bash
acpx codex set-mode auto
acpx codex set-mode plan -s backend
acpx set-mode auto       # defaults to codex
```

Calls ACP `session/set_mode`. The set of valid `<mode>` values is **adapter-defined** and not standardized across ACP. Common values seen in the wild:

| Adapter  | Modes                                          |
| -------- | ---------------------------------------------- |
| `codex`  | adapter-defined (see codex-acp release notes)  |
| `claude` | adapter-defined; `plan` and `auto` are typical |
| Others   | check upstream agent docs                      |

Unsupported mode ids are rejected by the adapter, often as `Invalid params`. `acpx` surfaces that error code unchanged.

`set-mode` routes through the queue owner when active and falls back to a fresh client connection otherwise.

The mode is saved on the session record and re-applied whenever `acpx` binds that record to a fresh adapter session — a respawned queue owner, an agent process that died, a `session/resume` that fell back to `session/load` or `session/new`. Adapters start every new session at their own default, so without this a restart would quietly return the session to `agent`/`auto` and with it the adapter's self-approval. If the adapter refuses the saved mode on that fresh session, the turn is not failed: the refusal is recorded in the session event log as an `_acpx/warning` with `code: SESSION_MODE_NOT_REAPPLIED`, naming the mode that is not in force.

A session the current queue owner still holds open keeps the mode its live adapter session is already running under; the re-apply is for new bindings, not for every turn.

## `set <key> <value>`

```bash
acpx claude set verbosity terse
acpx set model gpt-5.4         # defaults to codex
```

Calls ACP `session/set_config_option` with the literal `<key>` and `<value>`. `set_config_option` values are persisted by `acpx` and replayed onto fresh adapter sessions when the adapter supports those config keys. A `mode` config option is stored as the session mode and follows the [`set-mode`](#set-mode) rules above.

### `set model <id>`

`set model <id>` is a special-case interception. `acpx` prefers an advertised model session config option and updates it through `session/set_config_option`. If an adapter explicitly advertises legacy `models` metadata instead, `acpx` preserves compatibility through `session/set_model`.

Current codex-acp releases advertise the base model and reasoning effort as separate config options.

```bash
acpx codex set model gpt-5.6-sol
acpx codex set reasoning_effort max
acpx claude set model claude-sonnet-4-6
```

For setting the model at session creation instead, use the `--model` global flag. See [Prompting](prompting.md#models).

## `status`

```bash
acpx codex status
acpx codex status -s backend
acpx status              # defaults to codex
```

Reports local process status for the cwd-scoped session:

| State         | Meaning                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `running`     | Queue owner alive and processing a prompt                                                        |
| `idle`        | Saved session resumable, no queue owner running                                                  |
| `unreachable` | Queue owner process is alive but not answering (suspended, wedged, or its heartbeat has stopped) |
| `dead`        | No live queue owner and the last agent exit was abnormal                                         |
| `no-session`  | No saved record matches this scope                                                               |

Plus, when applicable: session id, agent command, live queue-owner pid, uptime,
last prompt timestamp, and last known exit code or signal for `dead`.

`status` is local — it uses `kill(pid, 0)` semantics and does not touch the
agent, and it never retires a queue owner it cannot reach: an owner that is
merely suspended or busy is reported as `unreachable` and left running. Cached session PIDs are not reported unless a live queue-owner lease ties
them to the session. It is safe to run from automation that polls for queue
readiness.

### Output

- `text`: key/value lines (default).
- `json`: full record with `acpxRecordId`, `acpxSessionId`, optional `agentSessionId`, plus state and timestamps.

`idle` is meaningful: it means the persistent session is saved and resumable, but no queue owner is currently running. The next prompt will start an owner and reconnect.

## Routing rules

All four commands (`cancel`, `set-mode`, `set`, `status`) try the queue owner first when one exists for the target session. If no owner is running:

- `cancel` short-circuits with `nothing to cancel`.
- `set-mode` and `set` reconnect to the saved adapter session and apply the change directly.
- `status` simply reports `idle`, `unreachable`, or `dead`.

This means it is always safe to call these from scripts without worrying about whether a queue owner happens to be running.

## See also

- [Prompting](prompting.md) — `--no-wait` and timeouts.
- [Sessions](sessions.md) — scope rules and queue ownership.
- [CLI reference](CLI.md#cancel-command) — formal command grammar.
