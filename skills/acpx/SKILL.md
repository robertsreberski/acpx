---
name: acpx
description: Use acpx as a headless ACP CLI or session-service backend for agent-to-agent communication, including prompt/exec/sessions workflows, session scoping, queueing, permissions, output formats, system-prompt overrides, the separate ACPX Console, and multi-agent flows authored with defineFlow/decision/decisionEdge.
---

# acpx

## When to use this skill

Use this skill when you need to run coding agents through `acpx`, manage persistent ACP sessions, queue prompts, override the Claude system prompt, prune stale sessions, consume structured agent output from scripts, or compose multi-agent workflows declaratively with `acpx/flows`.

## What acpx is

`acpx` is a headless, scriptable CLI client for the Agent Client Protocol (ACP). It is built for agent-to-agent communication over the command line and avoids PTY scraping.

Core capabilities:

- Persistent multi-turn sessions per repo/cwd
- One-shot execution mode (`exec`)
- Named parallel sessions (`-s/--session`)
- Idempotent session creation (`sessions ensure`)
- Session retention controls (`sessions prune` with age filters and history cleanup)
- Portable session export/import for moving records and history across machines
- Queue-aware prompt submission with optional fire-and-forget (`--no-wait`)
- Cooperative cancel command (`cancel`) for in-flight turns
- Graceful cancellation via ACP `session/cancel` on interrupt
- Session control methods (`set-mode`, `set <key> <value>`)
- Agent reconnect/resume after dead subprocess detection
- Prompt input via stdin or `--file`
- Config files with global+project merge and `config show|init`
- Session metadata/history inspection (`sessions show`, `sessions history`, `sessions read`)
- Local agent process checks via `status`
- Deferred permission requests and form elicitations (`--defer`, `requests`, `respond`) for answering an agent out of band
- MCP servers passed to agent sessions via the `mcpServers` config key or `--mcp-config`
- Stable ACP client methods for filesystem and terminal requests
- Stable ACP `authenticate` handshake via env/config credentials
- Structured streaming output (`text`, `json`, `quiet`) with optional `--suppress-reads`
- Built-in agent registry plus raw `--agent` escape hatch
- Claude system prompt override via `--system-prompt` / `--append-system-prompt`
- Optional ACP filesystem and terminal capability opt-outs via `--no-fs` and `--no-terminal`
- Tool whitelist (`--allowed-tools`), turn cap (`--max-turns`), retry on transient failures (`--prompt-retries`)
- Multi-agent flows via `acpx flow run` and the `acpx/flows` authoring API (`defineFlow`, `decision`, `decisionEdge`, `acp`, `action`, `compute`, `checkpoint`)
- A public `acpx/sessions` service for exact-record session inventory, complete
  transcript paging, queue-aware mutations, provider-session adoption, and
  permission or elicitation responses
- A separately installed `acpx-console` web workspace for human session
  inspection and control; it has no mono-agent dependency and does not replace
  the headless CLI

## Install

```bash
npm i -g acpx
```

For normal session reuse, prefer a global install over `npx`.

After its first independent release, install the optional standalone web
console separately:

```bash
npm i -g acpx-console
acpx-console start --open
```

The console reads and controls the same ACPX sessions through `acpx/sessions`.
Stopping it never stops queue owners or active turns. It has no application
login: localhost is the default, and any non-loopback listener requires the
explicit `--trust-network` acknowledgement. Treat every browser that can reach
that listener as a fully authorized operator.

## Command model

`prompt` is the default verb.

```bash
acpx [global_options] [prompt_text...]
acpx [global_options] prompt [prompt_options] [prompt_text...]
acpx [global_options] exec [prompt_options] [prompt_text...]
acpx [global_options] compare <agent>... '<prompt_text>'
acpx [global_options] compare <agent>... --file <path>
acpx [global_options] cancel [-s <name>]
acpx [global_options] set-mode <mode> [-s <name>]
acpx [global_options] set <key> <value> [-s <name>]
acpx [global_options] status [-s <name>]
acpx [global_options] requests [list] [--all] [--json] [-s <name>]
acpx [global_options] respond <request-id> (--option <id> | --accept | --field <key=value>... | --text <answer> | --decline | --cancel) [--json] [-s <name>]
acpx [global_options] sessions [list | new [-s|--name <name>] [--resume-session <id>] | ensure [-s|--name <name>] [--resume-session <id>] | close [name] | show [name] | history [name] [--limit <count>] | read [name] [--tail <count>] | export [name] --output <path> | import <archive> [--name <name>] [--cwd <dir>] | prune [--dry-run] [--before <date> | --older-than <days>] [--include-history]]
acpx [global_options] config [show | init]
acpx [global_options] flow run <file> [--input-json '<json>' | --input-file <path>] [--default-agent <name>]

acpx [global_options] <agent> [prompt_options] [prompt_text...]
acpx [global_options] <agent> prompt [prompt_options] [prompt_text...]
acpx [global_options] <agent> exec [prompt_options] [prompt_text...]
acpx [global_options] <agent> cancel [-s <name>]
acpx [global_options] <agent> set-mode <mode> [-s <name>]
acpx [global_options] <agent> set <key> <value> [-s <name>]
acpx [global_options] <agent> status [-s <name>]
acpx [global_options] <agent> requests [list] [--all] [--json] [-s <name>]
acpx [global_options] <agent> respond <request-id> (--option <id> | --accept | --field <key=value>... | --text <answer> | --decline | --cancel) [--json] [-s <name>]
acpx [global_options] <agent> sessions [list | new [-s|--name <name>] [--resume-session <id>] | ensure [-s|--name <name>] [--resume-session <id>] | close [name] | show [name] | history [name] [--limit <count>] | read [name] [--tail <count>] | export [name] --output <path> | import <archive> [--name <name>] [--cwd <dir>] | prune [--dry-run] [--before <date> | --older-than <days>] [--include-history]]
```

If prompt text is omitted and stdin is piped, `acpx` reads prompt text from stdin.

## Built-in agent registry

Friendly agent names resolve to commands:

- `pi` -> `npx pi-acp`
- `openclaw` -> `openclaw acp`
- `codex` -> `npx -y @agentclientprotocol/codex-acp` (ACPX-owned package range)
- `claude` -> `npx -y @agentclientprotocol/claude-agent-acp` (ACPX-owned package range)
- `gemini` -> `gemini --acp`
- `cursor` -> `cursor-agent acp`
- `copilot` -> `copilot --acp --stdio`
- `droid` -> `droid exec --output-format acp` (`factory-droid` and `factorydroid` also resolve to `droid`)
- `fast-agent` -> `uvx fast-agent-mcp acp`
- `grok-build` -> `grok agent stdio`
- `iflow` -> `iflow --experimental-acp`
- `kilocode` -> `npx -y @kilocode/cli acp`
- `kimi` -> `kimi acp`
- `kiro` -> `kiro-cli-chat acp`
- `mux` -> `mux acp` via an ACPX-owned npm range
- `opencode` -> `npx -y opencode-ai acp`
- `pool` -> `pool acp`
- `qoder` -> `qodercli --acp`
  Forwards Qoder-native `--allowed-tools` and `--max-turns` startup flags from `acpx` session options.
- `qwen` -> `qwen --acp`
- `trae` -> `traecli acp serve`
- `zeroclaw` -> `zeroclaw acp`

Rules:

- Default agent is `codex` for top-level `prompt`, `exec`, and `sessions`.
- Unknown positional agent tokens are treated as raw agent commands.
- `--agent <command>` explicitly sets a raw ACP adapter command.
- Do not combine a positional agent and `--agent` in the same command.

## Commands

### Prompt (default, persistent session)

Implicit:

```bash
acpx codex 'fix flaky tests'
```

Explicit:

```bash
acpx codex prompt 'fix flaky tests'
acpx prompt 'fix flaky tests'   # defaults to codex
```

Behavior:

- Uses a saved session for the session scope key
- Auto-resumes prior session when one exists for that scope
- If no session exists for the scope, exits with `NO_SESSION` and prompts for `sessions new`
- Requires the exact saved provider session to resume or load. If it cannot, the prompt fails closed; run `sessions new` explicitly only when a fresh conversation is intended.
- Is queue-aware when another prompt is already running for the same session
- On interrupt during an active turn, sends ACP `session/cancel` before force-kill fallback

Prompt options:

- `-s, --session <name>`: use a named session within the same cwd
- `--no-wait`: enqueue and return immediately when session is already busy
- `-f, --file <path>`: read prompt text from file (`-` means stdin)

### Exec (one-shot)

```bash
acpx exec 'summarize this repo'
acpx codex exec 'summarize this repo'
```

Behavior:

- Runs a single prompt in a temporary ACP session
- Does not reuse or save persistent session state
- Exits `6` when exact Codex compaction metadata is not followed by exact final-answer metadata; the temporary session is discarded and any retry is explicit

### Compare (multi-agent one-shot)

```bash
acpx compare pi openclaw codex 'summarize this checkout'
acpx --format json compare codex claude --file prompt.md
```

Behavior:

- Runs the same temporary-session prompt against each listed agent
- Runs agents serially in the requested workspace
- Reuses the global `exec` controls: cwd, timeout, permissions, `--policy`, auth, terminal, retries, model/effort/system options, and output format
- `--format text` prints one summary table row per agent
- `--format json` or `--json` prints `CompareRow[]`
- `--format quiet` prints `<agent>\t<status>` per row
- `--json` is a local alias for `--format json`, and `--prompt-file` a local alias for `-f/--file`
- An unresolved Codex compaction produces status `incomplete`, `incomplete_reason: "context_compaction"`, and exit `6` unless an error, permission denial, or cancellation takes precedence
- Does not create saved sessions or separate compare transcript directories

### Cancel / Mode / Config / Model

```bash
acpx codex cancel
acpx codex set-mode auto
acpx codex set model gpt-5.6-sol
acpx codex set reasoning_effort max
acpx --model gpt-5.6-sol --effort max codex 'review the changed files'
```

Behavior:

- `cancel`: sends cooperative `session/cancel` through queue-owner IPC.
- `set-mode`: calls ACP `session/set_mode`.
- `set-mode` mode ids are adapter-defined; unsupported values are rejected by the adapter (often `Invalid params`).
- `set`: calls ACP `session/set_config_option`.
- Current codex-acp releases expose `model` and `reasoning_effort` as separate config options.
- `--model <id>`: Claude-compatible adapters may consume session creation metadata; other agents must advertise a model config option or legacy `models` metadata.
- `--effort <level>`: resolves the adapter's advertised thought-level select option, after applying `--model`; values are model-specific and unsupported values fail before the prompt with the advertised choices.
- `set model <id>`: uses `session/set_config_option` for advertised model config options and preserves `session/set_model` for explicitly advertised legacy models.
- Direct effort controls such as `set reasoning_effort max` remain compatible and update the same persisted effort preference as `--effort`.
- `set-mode`/`set` route through queue-owner IPC when active, otherwise reconnect directly.
- Direct control reconnects require the exact saved provider session, just like persistent prompts. If `session/resume` or `session/load` cannot restore it, the command fails with `SESSION_RESUME_REQUIRED`; use `sessions new` explicitly only when replacing the conversation is intended.
- The mode is saved on the session record and re-applied whenever `acpx` binds that record to a fresh adapter process (respawned queue owner, dead agent process, or `session/resume` that fell back to `session/load`), so it survives owner restarts. A refusal by the adapter does not fail the turn: it is logged as an `_acpx/warning` with `code: SESSION_MODE_NOT_REAPPLIED`.
- **Set the mode before the session's first prompt.** A warm owner between turns keeps its adapter session and applies `set-mode` to a throwaway connection instead, so the record updates but the next prompt still runs at the old mode. `status` does not show the discrepancy. On an already-warm session, retire the owner (`sessions close`, or let `--ttl` lapse) before prompting again.

### Deferred permission requests

```bash
acpx codex set-mode read-only   # codex self-approves in its sandbox without this; set it before the first prompt
acpx --defer --policy '{"defer":["execute"]}' codex prompt --no-wait 'run the repo checks'
acpx codex requests --json
acpx codex respond <request-id> --option allow
acpx codex respond <request-id> --field question_0='Greeting A'
acpx codex respond <request-id> --text 'my own answer'
acpx codex respond <request-id> --decline
acpx codex respond <request-id> --cancel
```

Behavior:

- **Codex parks nothing until its session is set to `read-only`** (`acpx codex set-mode read-only`): its default `agent` preset approves its own tool calls inside its sandbox and never sends a permission request. Set it **before the session's first prompt** — on a session whose queue owner is already warm the change does not reach the session the next prompt uses, and that prompt self-approves with nothing parked; retire the owner first (`sessions close`, or let `--ttl` lapse). Agents that do not self-sandbox, such as `claude`, need nothing extra. Codex also offers no `reject_always` option and sends no tool title, so `--decline` uses `reject_once` and the listing shows the `tool` fallback — read `raw_input` for the command.
- Two spellings reach that same codex preset, and they are **different ACP calls**: `set-mode read-only` is `session/set_mode`, while `set mode read-only` is `session/set_config_option` against the `mode` option codex advertises (`read-only` / `agent` / `agent-full-access`). `docs/deferred-requests.md` writes it the second way. Prefer `set-mode`: it is the one the session record stores as its mode and re-applies on every rebind, and the one whose failure to re-apply is reported as `SESSION_MODE_NOT_REAPPLIED` — so a mode that quietly stopped being in force is visible rather than silent.
- `--defer` parks `defer`-matched permission requests instead of denying them for the turn: the turn stays blocked and a durable record is written under `~/.acpx/requests/`.
- `--defer` and `--defer-max-age <seconds>` are owner-level, fixed when the session's queue owner starts; a submit a warm owner cannot honour is refused, not silently denied.
- `requests` lists parked requests from the durable store, so it still works when the queue owner is unreachable. `--all` covers every session, needs no session in the current directory, and cannot be combined with `-s`. `requests list` is the same command spelled explicitly.
- `--json` is a local alias for `--format json` on both `requests` and `respond`.
- `requests` observes only: it never rewrites request state and never touches the owner process. A request left `pending` by a dead owner is reconciled to `orphaned` by `respond` or by the session's next queue owner.
- `-s` takes a session **name**; the JSON carries `session_id` and `cwd`. Answer a request listed by `--all` from its `cwd`.
- `requests --json` prints the persisted store entries verbatim (snake_case, `acpx.pending_request.v1`). Bind scripts to that shape.
- `respond` takes exactly one answer: `--option <optionId>`, the `--accept`/`--field`/`--text` form group, `--decline`, or `--cancel`. Option ids come from the `options` array of the listed request.
- Parked requests come in two kinds. `kind: "permission"` carries `tool_call` and `options` and is answered with `--option`. `kind: "elicitation"` carries `elicitation.requested_schema` (the agent's JSON Schema, verbatim) and is answered with `--field <key>=<value>` (repeatable) or `--text <answer>` for a one-field form. Using the wrong one is exit `2` with a message naming what the request does take.
- Form elicitation is advertised to the agent **only** when the owner runs with `--defer`, because parking is the only way acpx can answer one. This is what re-enables `AskUserQuestion` in `claude-agent-acp`; without `--defer` the agent keeps its stock behaviour and never asks.
- `--field` values are coerced by the schema's declared `type`: `boolean` takes exactly `true`/`false`, `number`/`integer` take **JSON** numbers (`0x1F`, `007`, `+5` are refused, not silently read as 31, 7, 5), `string`/untyped take the raw text. Anything else is exit `2` rather than a guess.
- For a `type: "array"` multi-select, repeat the flag — `--field picks=a --field picks=b` — which takes each value literally and reaches values containing commas or padded whitespace. A single occurrence comma-splits as sugar, but is refused when an offered value contains a comma, and items are checked against the values the schema lists.
- `--accept` accepts a form with whatever `--field` values are given; on its own it sends empty content, which is the only way to answer a form declaring no properties. It still cannot skip a required field.
- Declining an elicitation tells the agent the form was skipped and the turn carries on; expiry declines too and never accepts.
- `respond` exits `2` when the answer cannot apply (unknown option, unknown or settled request) and `4` when the owner that parked the request is gone.
- `status` reports the parked count (`parkedRequests` in JSON), counting `pending` requests only.
- `respond` waits indefinitely by default. Pass the global `--timeout <seconds>` to bound it: exit `3` with `detailCode: "PENDING_REQUEST_ANSWER_TIMEOUT"`. The bound covers reaching the owner as well as waiting for it. If the owner was reached the answer may still be applied afterwards — re-read the request instead of assuming it failed; if it was never reached, nothing was delivered.
- Inspection never retires a queue owner. A live owner that is not answering shows as `status: unreachable`, distinct from `dead`.

### Sessions

```bash
acpx sessions
acpx sessions list
acpx sessions list --filter-cwd .
acpx sessions list --cursor <cursor>
acpx sessions list --local
acpx sessions new
acpx sessions new --name backend
acpx sessions ensure
acpx sessions ensure --name backend
acpx sessions close
acpx sessions close backend
acpx sessions new --resume-session <acp-session-id>
acpx sessions show
acpx sessions history --limit 20
acpx sessions read
acpx sessions read backend --tail 100
acpx sessions export backend --output backend-session.json
acpx sessions import backend-session.json --name backend-restored
acpx sessions prune --dry-run --older-than 7
acpx sessions prune --older-than 30 --include-history
acpx status

acpx codex sessions
acpx codex sessions new --name backend
acpx codex sessions ensure --name backend
acpx codex sessions close backend
acpx codex sessions show backend
acpx codex sessions history backend --limit 20
acpx codex sessions read backend --tail 100
acpx codex sessions export backend --output backend-session.json
acpx codex sessions import backend-session.json --name backend-restored
acpx codex sessions prune --before 2026-04-01 --include-history
acpx codex status
```

Behavior:

- `sessions` and `sessions list` are equivalent
- `sessions list` uses ACP `session/list` when the agent advertises it; JSON
  includes agent `SessionInfo`, `_meta`, and `nextCursor`
- `sessions list --filter-cwd <dir>` applies the ACP cwd filter, and
  `--cursor <cursor>` requests a specific page
- `sessions list --local` reads saved acpx records instead
- `new` creates a fresh session for the current `(agentCommand, cwd, optional name)` scope
- `new --name <name>` targets a named session scope. On `new` and `ensure` only, `-s` is an alias for `--name` — everywhere else `-s` is `--session`.
- `new --resume-session <id>` and `ensure --resume-session <id>` bind the record to an ACP session id the agent already has, instead of asking for a new one
- when `new` replaces an existing open session in that scope, the old one is soft-closed
- `ensure` returns the nearest matching active session for the scope, or creates one when none is open. Idempotent — safe to call before every prompt in scripts.
- `close` targets current cwd default session
- `close <name>` targets current cwd named session
- `show [name]` prints stored metadata for that scoped session
- `history [name]` prints stored turn history previews (default 20, use `--limit`)
- `read [name]` prints the whole stored history instead of a capped preview; `--tail <count>` keeps only the last N entries
- `export [name] --output <path>` writes a portable JSON archive containing session state and event history
- `import <archive>` creates a fresh local record, reopens the copied session as idle, keeps the provider session id, and clears source-machine process metadata
- imported sessions must resume that provider session; if the destination agent cannot load it, prompts fail clearly instead of starting an empty conversation
- `import --name <name>` and `--cwd <dir>` override the destination scope; import fails if that scope already has an active session or another local record already uses the same provider session id
- `prune` deletes closed session records to reclaim disk space
  - `--dry-run` previews what would be deleted without touching disk
  - `--older-than <days>` and `--before <date>` filter by close time, falling back to last-used time when a record was never explicitly closed
  - `--include-history` also removes per-session event stream files (otherwise only the JSON record is removed)

## Global options

- `--agent <command>`: raw ACP agent command (escape hatch)
- `--cwd <dir>`: working directory for session scope (default: current directory)
- `--auth-policy <policy>`: what to do when the agent requires ACP `authenticate` — `skip` (default) continues and lets the adapter handle its own auth, `fail` stops rather than proceeding without a matching credential
- `--approve-all`: auto-approve all permission requests
- `--approve-reads`: auto-approve reads/searches, prompt for writes (default mode)
- `--deny-all`: deny all permission requests
- `--non-interactive-permissions <policy>`: when prompting is unavailable, choose `deny` or `fail`
- `--permission-policy <json-or-file>` / `--policy`: per-tool ACP permission rules (`autoApprove`, `autoDeny`, `escalate`, `defer`, `defaultAction`)
- `--format <fmt>`: output format (`text`, `json`, `quiet`)
- `--json-strict`: strict JSON mode; requires `--format json` and suppresses non-JSON stderr output
- `--suppress-reads`: suppress raw read-file contents while preserving the selected format
- `--timeout <seconds>`: max wait time (positive number)
- `--ttl <seconds>`: queue owner idle TTL before shutdown (default `300`, `0` disables TTL)
- `--defer`: park `defer`-matched permission requests for `acpx <agent> respond` instead of denying them for the turn
- `--defer-max-age <seconds>`: how long a parked request waits before expiring like a rejection (default `86400`, `0` never expires)
- `--model <id>`: request an agent model during session creation; non-Claude agents must advertise a model config option or legacy `models` metadata
- `--effort <level>`: request an advertised thought/reasoning level; model is applied first, and valid values may differ per model
- `--system-prompt <text>`: replace the agent system prompt. Forwarded to claude-agent-acp via ACP `_meta.systemPrompt`; persisted in `session_options.system_prompt` so reuse keeps the override. Other agents ignore the field.
- `--append-system-prompt <text>`: append text to the agent system prompt. Forwarded to claude-agent-acp via ACP `_meta.systemPrompt.append`; same persistence rules as `--system-prompt`.
- `--allowed-tools <list>`: comma-separated tool whitelist (use `""` for no tools)
- `--max-turns <count>`: cap session turn count
- `--prompt-retries <count>`: retry failed prompt turns on transient errors (default `0`)
- `--no-fs`: advertise both ACP filesystem capabilities as disabled so compatible agents use their native file operations
- `--no-terminal`: do not advertise the ACP terminal capability — useful for review-only or sandboxed agent invocations
- `--mcp-config <path>`: load MCP servers from a JSON file instead of the project/global `mcpServers` config
- `--verbose`: verbose ACP/debug logs to stderr

Cursor may advertise bracketed model ids such as `composer-2.5[fast=false]`. A bare Cursor
model name is normalized only when exactly one advertised bracketed variant matches it.

Permission flags are mutually exclusive.

## System prompt override (Claude)

`--system-prompt` and `--append-system-prompt` let you specialize a Claude session without leaving lingering one-off state, while still benefiting from persistent session reuse.

```bash
# Replace the system prompt for a named session, persisted across reuse
acpx --system-prompt "You are a code reviewer who challenges every implicit assumption." claude -s review

# Append a guideline on top of the default system prompt
acpx --append-system-prompt "Always explain trade-offs before recommending a fix." claude -s impl
```

The override is forwarded via ACP `_meta.systemPrompt` (or `_meta.systemPrompt.append`) on `session/new` and stored in `session_options.system_prompt`. Subsequent `prompt`/`ensure` calls in the same scope keep the override unless you explicitly create a new session. Non-Claude adapters ignore the field, so the same flag is safe inside cross-agent scripts.

## Claude settings isolation

Built-in `acpx claude` sessions load Claude project and local settings, but not
user settings. This prevents globally enabled channel and daemon plugins from
claiming singleton external resources in an ACP-spawned session.

Set `ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1` only when the spawned session needs
the user's global Claude settings and no such plugin conflict exists. Ambient
credentials and other environment variables are still inherited normally.

## Sessions cleanup

Closed session records accumulate on disk by default. Use `sessions prune` to enforce retention:

```bash
# Preview what would be deleted (no writes)
acpx codex sessions prune --dry-run --older-than 7

# Remove records closed more than 30 days ago, including their event-stream files
acpx codex sessions prune --older-than 30 --include-history

# Remove everything closed before a date
acpx codex sessions prune --before 2026-04-01
```

Without `--include-history`, only the lightweight JSON record is removed; event-stream files are preserved for audit. With it, the per-session event log is also deleted to reclaim disk space.

## Config files

Config files are merged in this order (later wins):

- global: `~/.acpx/config.json`
- project: `<cwd>/.acpxrc.json`

Supported keys:

- `defaultAgent`
- `defaultPermissions` (`approve-all`, `approve-reads`, `deny-all`)
- `nonInteractivePermissions` (`deny`, `fail`)
- `authPolicy` (`skip` default, `fail`) — matches `--auth-policy`
- `ttl` (seconds)
- `timeout` (seconds or `null`)
- `format` (`text`, `json`, `quiet`)
- `mcpServers` array — MCP servers sent to new _and_ loaded ACP sessions, e.g. `[{ "name": "local-tools", "type": "stdio", "command": "./bin/mcp-server" }]`. Unlike the other keys, a project value **replaces** the global list rather than merging into it.
- `agents` map (`name -> { argv: [executable, ...args] }`); structured argv is required on Windows, and legacy `{ command, args }` entries migrate automatically
- `auth` map (`authMethodId -> credential`)

Use `acpx config show` to inspect the resolved config and `acpx config init` to create the global template.

`--mcp-config <path>` points at a JSON file carrying that same top-level `mcpServers` array
and replaces the project/global value for one invocation — use it when the servers belong to
an automation job rather than the working tree. Relative paths resolve from `--cwd`. A
persistent session cannot switch MCP configuration while its queue owner is live: close the
session first, then run again with the new file.

For ACP `authenticate` handshakes, use either config `auth` entries or explicit
`ACPX_AUTH_<METHOD_ID>` environment variables such as `ACPX_AUTH_OPENAI_API_KEY`.
Ambient provider env vars such as `OPENAI_API_KEY` are still passed through to
child agents, but they do not trigger ACP auth-method selection on their own.

### mono-agent sources

A mono-agent source is agent identity, not an ACP model. Keep its model and
effort in `mono-agent.config.json`, then select one exact running source through
an ordinary structured-argv alias:

```json
{
  "agents": {
    "mono-personal": {
      "argv": ["mono-agent", "bridge", "acp", "--source-id", "personal-agent"]
    }
  },
  "mcpServers": []
}
```

The full argv participates in acpx session identity, so changing the source id
selects a different scope without custom routing code. mono-agent owns its
workspace, filesystem and terminal execution, MCP servers, credentials, and
conversation history. Its bridge accepts acpx's standard filesystem and
terminal capability advertisement but does not call those client methods; it
requires an empty client MCP list and no additional directories.

Current mono-agent bridges advertise `session/resume`, allowing acpx to retain
the exact provider session across bridge and source restarts. Resume fails
closed for unknown, cross-source, corrupt, pre-registry, or reset ids. Use a
stable acpx `--cwd` because acpx still scopes its own record by cwd even though
mono-agent treats the ACP cwd as advisory. For mono-agent `AskUser`, start the
queue owner with `--defer` so acpx advertises and can park form elicitation.

See [`agents/MonoAgent.md`](../../agents/MonoAgent.md) for setup, lifecycle, and
ownership details.

## Devin ACP compatibility

Devin is not a built-in agent shortcut. Use the raw command escape hatch:

```bash
acpx --agent 'devin acp' exec 'summarize this repo'
```

Pass Devin global flags such as `--model <model>` before `acp` when needed.

When `acpx` detects a Devin ACP launch (`devin ... acp`, `devin ... --acp`, or `devin ... --experimental-acp`), it advertises the minimum Windsurf-compatible metadata needed for Devin's ACP gate:

- `clientInfo.name`: `windsurf` instead of `acpx`
- `clientInfo.version`: `ACPX_DEVIN_WINDSURF_VERSION` env var, default `1.110.1`
- `clientCapabilities`: standard `fs` and `terminal` support, plus `_meta["cognition.ai/requestDiagnostics"] = true`
- Extension handling: returns `{}` for Devin `_cognition.ai/request_diagnostics` requests and accepts extension notifications without method-not-found noise

This compatibility shim is scoped to Devin ACP launches only. Other agents continue to receive standard `acpx` identity and capabilities.

See the repository [`agents/Devin.md`](https://github.com/openclaw/acpx/blob/main/agents/Devin.md) for the full Devin compatibility contract.

## Session behavior

Persistent prompt sessions are scoped by:

- `agentCommand`
- absolute `cwd`
- optional session `name`

Persistence:

- Session records are stored in `~/.acpx/sessions/*.json`.
- `-s/--session` creates parallel named conversations in the same repo.
- Changing `--cwd` changes scope and therefore session lookup.
- closed sessions are retained on disk with `closed: true` and `closedAt` until pruned.
- auto-resume by scope skips closed sessions.

Resume behavior:

- Prompt mode attempts to reconnect to saved session.
- If the adapter-side session is invalid, missing, or unsupported, a persistent prompt fails instead of replacing the conversation with a fresh session. The narrow exception is the first prompt after `sessions new` when the untouched record advertises neither `session/resume` nor `session/load`; `acpx` may initialize that empty conversation with `session/new` while preserving its local record identity.
- `sessions new` is the explicit escape hatch when starting a fresh conversation is intended.
- explicitly selected session records can still be resumed via `loadSession` even if previously closed.
- dead saved PIDs are detected and reconnected on the next prompt.
- each completed prompt stores lightweight turn history previews in the session record.

## Prompt queueing and `--no-wait`

Queueing is per persistent session.

- The active `acpx` process for a running prompt becomes the queue owner.
- Other invocations submit prompts over local IPC.
- On Unix-like systems, queue IPC uses a Unix socket under `~/.acpx/queues/<hash>.sock`.
- Ownership is coordinated with a lock file under `~/.acpx/queues/<hash>.lock`.
- On Windows, named pipes are used instead of Unix sockets.
- after the queue drains, owner shutdown is governed by TTL (default 300s, configurable with `--ttl`).

Submission behavior:

- Default: enqueue and wait for queued prompt completion, streaming updates back.
- `--no-wait`: enqueue and return after queue acknowledgement.
- If a no-wait Codex turn later ends incomplete after context compaction, `_acpx/turn_incomplete` is retained in the durable per-session event stream.
- `Ctrl+C` during an active turn sends ACP `session/cancel`, waits briefly, then force-kills only if cancellation does not finish in time.
- `cancel` sends the same cooperative cancellation without requiring terminal signals.

## Output formats

Use `--format <fmt>`:

- `text` (default): human-readable stream with updates/tool status and done line
- `json`: ACP NDJSON plus acpx JSON-RPC extension notifications under `_acpx/*` (good for automation)
- `quiet`: final assistant text on stdout; failed prompts emit one structured `[acpx] error:` line on stderr and incomplete prompts emit one `[acpx] incomplete:` line
- `--suppress-reads`: replace raw read-file contents with `[read output suppressed]` in `text` and `json` output
- `--json-strict`: pair with `--format json` to suppress non-JSON stderr noise (logs, banners) for downstream consumers

Example automation:

```bash
acpx --format json codex exec 'review changed files' \
  | jq -r 'select(.type=="tool_call") | [.status, .title] | @tsv'
```

### Incomplete Codex turns

Treat `_acpx/turn_incomplete` as a terminal non-success result. `acpx` emits it only when an update has exact `_meta.contextCompaction: true`, the adapter returns a non-cancel stop reason, and no later non-empty `agent_message_chunk` has exact `_meta.codex.phase: "final_answer"` in that prompt attempt. It does not guess from prose or tool titles.

- Waited `prompt`, `exec`, and `compare` exit `6`.
- Persistent prompt keeps the exact provider session. Continue with another explicit prompt in the same scope; do not assume `acpx` sent a hidden follow-up.
- `exec` and `compare` discard temporary sessions after reporting incomplete, so rerun explicitly if needed.
- `--format json` emits `{"jsonrpc":"2.0","method":"_acpx/turn_incomplete","params":{"reason":"context_compaction","stopReason":"end_turn"}}`.
- The embedding runtime returns status `incomplete` with the adapter's actual stop reason; legacy `runTurn()` emits `done` with `incomplete: true` and reason `context_compaction`.

## Permission modes

- `--approve-all`: no interactive permission prompts
- `--approve-reads` (default): approve reads/searches, prompt for writes
- `--deny-all`: deny all permission requests
- `--non-interactive-permissions <deny|fail>`: chosen behavior when no TTY is available to prompt
- `--policy <json-or-file>`: match ACP permission requests by tool kind/title; non-interactive escalations add ACP response metadata
- `--defer` with a `defer` rule parks the request for `acpx <agent> respond` instead of denying it for the turn

If every permission request is denied/cancelled and none approved, `acpx` exits with permission-denied status.

## Flows (multi-agent workflows)

Flows let you declare a multi-agent workflow as a graph of typed nodes connected by edges, executed by the `acpx` runtime. The runtime owns persistence, retries, timeouts, and routing — the flow file declares the shape, not the engine.

An unresolved Codex compaction gives the `acp` node outcome `incomplete`. The runtime saves the raw response and `trace.turn`, skips the node's `parse` callback, does not publish partial output, and allows routing on `$result.outcome`.

### Run a flow

```bash
acpx flow run ./my-flow.flow.ts --input-file ./flow-input.json
acpx flow run ./my-flow.flow.ts --input-json '{"task":"FIX: add a regression test"}'
acpx --approve-all flow run examples/flows/pr-triage/pr-triage.flow.ts \
  --input-json '{"repo":"openclaw/acpx","prNumber":150}'
acpx flow run ./my-flow.flow.ts --default-agent claude
```

Run artifacts persist under `~/.acpx/flows/runs/<runId>/`. Default per-step timeout is 15 minutes when `--timeout` is unset; flows that declare permission requirements fail fast before starting.

### Authoring a flow

The authoring surface lives in `acpx/flows`. The minimal example:

```ts
import { acp, decision, decisionEdge, defineFlow, checkpoint, extractJsonObject } from "acpx/flows";

const choices = ["bug", "feat", "doc"] as const;

export default defineFlow({
  name: "pr-triage",
  startAt: "classify",
  nodes: {
    classify: decision({
      choices,
      question: ({ input }) =>
        `Classify the PR description below. Reply with one of: ${choices.join(", ")}.\n\n${input.description}`,
    }),
    bug_lane: acp({
      prompt: ({ outputs }) =>
        `The PR is a bug. Write a regression test that reproduces it.\n\nDecision context: ${JSON.stringify(outputs.classify)}`,
      parse: (text) => extractJsonObject(text),
    }),
    feat_lane: acp({
      prompt: () => "List acceptance criteria for the feature, one bullet per criterion.",
    }),
    doc_lane: checkpoint({
      summary: "doc change — needs human review",
      run: ({ outputs }) => ({ route: "doc", note: outputs.classify }),
    }),
  },
  edges: [
    decisionEdge({
      from: "classify",
      choices,
      cases: {
        bug: "bug_lane",
        feat: "feat_lane",
        doc: "doc_lane",
      },
    }),
  ],
});
```

### Node types

| Type                                    | Purpose                                                                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acp({ prompt, parse?, agent?, cwd? })` | Model-driven step. The `prompt` builder receives `{ input, outputs }`. Optional `parse` coerces the raw text (e.g., `extractJsonObject`).                        |
| `decision({ choices, question })`       | Constrained-choice LLM step. `choices` is a `readonly` tuple; the runtime validates the model's reply against it and TypeScript infers the union from `choices`. |
| `action(...)`                           | Runtime-supervised deterministic operation: shell, GitHub API, test execution, comment posting.                                                                  |
| `compute(...)`                          | Pure local data transform: normalization, routing key derivation, signal reduction.                                                                              |
| `checkpoint({ summary, run })`          | Pause point for human or external trigger. `run` returns the outcome to record while paused.                                                                     |

### Edge shapes

```ts
// Linear edge
{ from: "node", to: "next" }

// JSONPath switch — non-decision routing
{
  from: "node",
  switch: {
    on: "$.route",
    cases: { "value-a": "branch_a", "value-b": "branch_b" },
  },
}

// Decision edge — exhaustive at compile time
decisionEdge({
  from: "classify",
  choices,                                 // same readonly tuple as decision()
  cases: {                                 // every choice must map to a node id
    bug: "bug_lane",
    feat: "feat_lane",
    doc: "doc_lane",
  },
})
```

If a `decisionEdge` omits a case from `choices`, the TypeScript compiler refuses to compile — so a flow can't ship with a forgotten branch when new choices are added.

### Why use flows

- **Cross-vendor by construction**: classify with `codex`, write code with `claude`, summarize with `gemini` — same flow file, no glue.
- **Persistence and replay**: every run streams events to disk, replayable via the flow viewer under `~/.acpx/flows/runs/`.
- **Permission preflight**: flows declaring permission requirements fail before any agent starts, instead of mid-run.
- **Typed routing**: the LLM is constrained to a literal union, the compiler verifies exhaustivity, the runtime validates the reply.

See `examples/flows/` in the repo for working samples (`branch.flow.ts`, `pr-triage/`, `two-turn.flow.ts`, `shell.flow.ts`, `workdir.flow.ts`).

## Practical workflows

Persistent repo assistant:

```bash
acpx codex 'inspect failing tests and propose a fix plan'
acpx codex 'apply the smallest safe fix and run tests'
```

Parallel named streams:

```bash
acpx codex -s backend 'fix API pagination bug'
acpx codex -s docs 'draft changelog entry for release'
```

Specialized Claude reviewer that survives session reuse:

```bash
acpx --system-prompt "You are a reviewer who refuses to approve untested changes." claude -s reviewer
acpx claude -s reviewer 'review the diff in src/auth/'
```

Idempotent session bootstrap (safe to call before every prompt in scripts):

```bash
acpx codex sessions ensure -s ci
acpx codex -s ci 'run the smoke suite and report failures'
```

Queue follow-up without waiting:

```bash
acpx codex 'run full test suite and investigate failures'
acpx codex --no-wait 'after tests, summarize root causes and next steps'
```

One-shot script step:

```bash
acpx --format quiet exec 'summarize repo purpose in 3 lines'
```

Machine-readable output for orchestration:

```bash
acpx --format json --json-strict codex 'review current branch changes' > events.ndjson
```

Raw custom adapter command:

```bash
acpx --agent './bin/custom-acp-server --profile ci' 'run validation checks'
```

Periodic cleanup:

```bash
acpx codex sessions prune --dry-run --older-than 14
acpx codex sessions prune --older-than 30 --include-history
```

Multi-agent triage flow:

```bash
acpx --approve-all flow run ./pr-triage.flow.ts --input-json '{"prNumber": 842}'
```

Repo-scoped review with permissive mode:

```bash
acpx --cwd ~/repos/shop --approve-all codex -s pr-842 \
  'review PR #842 for regressions and propose minimal patch'
```
