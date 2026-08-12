---
title: Permissions
description: Permission modes, non-interactive policy, and how acpx handles ACP permission requests for tool calls and file writes.
---

ACP agents request permission for tool actions like writing files, running shell commands, or fetching URLs. `acpx` mediates those requests against a policy you choose at the command line (or in [config](config.md)).

## Modes

Choose exactly one. The flags are mutually exclusive — passing more than one is a usage error.

| Flag              | Behavior                                                                     |
| ----------------- | ---------------------------------------------------------------------------- |
| `--approve-all`   | Auto-approve every permission request without prompting.                     |
| `--approve-reads` | Auto-approve read/search requests; prompt for everything else. **(default)** |
| `--deny-all`      | Auto-deny/reject every permission request whenever the protocol allows.      |

Set a project default in `.acpxrc.json` or a global default in `~/.acpx/config.json`:

```json
{ "defaultPermissions": "approve-all" }
```

CLI flags always win over config.

## Per-tool policy

Use `--permission-policy <json-or-file>` (or `--policy`) to override selected ACP tool permission requests without changing the broader mode:

```bash
acpx --permission-policy '{"autoApprove":["read","search"],"escalate":["execute"],"defaultAction":"deny"}' \
     --format json codex exec 'run the repo checks'
```

Policy keys:

- `autoApprove`: tool kinds, tool title heads, titles, or raw input tool names to approve
- `autoDeny`: matched tools to deny
- `escalate`: matched tools that require user or orchestrator approval
- `defer`: matched tools whose decision belongs to an out-of-band reviewer rather than the current turn
- `defaultAction`: optional fallback for unmatched requests: `approve`, `deny`, `escalate`, or `defer`

Rule precedence is `autoDeny`, then `autoApprove`, then `escalate`, then `defer`, then `defaultAction`, then the normal permission mode. Matches are case-insensitive. In non-interactive output, an escalated request is denied for the current turn.

`defer` currently resolves exactly like `escalate` and differs only in what it reports: the emitted event carries `"action": "defer"` and a deferral message, so a host can tell a request it should have parked from one it was asked to approve now. Until something parks deferred requests, a deferred tool call is denied for the current turn like any other escalation. Text mode prints a `[permission]` notice; JSON mode keeps the raw ACP stream and includes structured escalation details, including tool input when supplied by the agent, in the `session/request_permission` response `_meta.acpx.permissionEscalation` object so an orchestrator can resume with a broader policy.

## What counts as a "read"

Read/search requests in `--approve-reads`:

- Reading file contents (`fs/read_text_file` and read-shaped tool calls)
- Listing directories
- Search/grep tool calls
- Anything the adapter classifies as non-mutating

Everything else — write, edit, shell command, network call, etc. — falls into the prompt-or-deny path.

## Interactive prompting

In an interactive TTY, `--approve-reads` shows:

```text
Allow <tool>? (y/N)
```

`y` approves the single request. `N` (default) denies it. The agent decides what to do with a denial — most adapters surface it as a tool error and let the model choose to retry, ask differently, or give up.

There is no per-session "approve next 3" option. Every non-read request is its own prompt unless you pass `--approve-all`.

`escalate` and `defer` rules also prompt here rather than emitting an event: when a TTY is available, the person at the terminal _is_ the escalation target, so the request is answered inline and no `permissionEscalation` event is produced. Both only surface a structured event when no TTY is available. Orchestrators that need the event unconditionally should run `acpx` without a TTY (a pipe is enough), which is already the case for queued and CI-driven prompts.

## Non-interactive policy

When there is no TTY (pipes, CI, queued prompts driven by another process), the prompt cannot be shown. `--non-interactive-permissions` decides what happens:

| Policy | Behavior                                                 |
| ------ | -------------------------------------------------------- |
| `deny` | Treat the un-promptable request as denied. **(default)** |
| `fail` | Fail the prompt with `PERMISSION_PROMPT_UNAVAILABLE`.    |

Set a project default if you want CI runs to fail loudly:

```json
{ "nonInteractivePermissions": "fail" }
```

## Deciding permissions in a host program

Programs embedding the runtime (`import { ... } from "acpx/runtime"`) can answer permission requests directly with `onPermissionRequest`, instead of relying on mode and policy alone:

```ts
const runtime = createAcpRuntime({
  // ...
  permissionMode: "deny-all",
  permissionPolicy: { defer: ["execute"] },
  onPermissionRequest: async (req, ctx) => {
    // ctx.mode and ctx.policy describe what acpx would do on its own.
    if (matchPermissionPolicy(req.raw, ctx.policy)?.action === "defer") {
      const optionId = await parkForHumanReview(req, ctx.signal);
      return optionId ? { outcome: "select", optionId } : { outcome: "cancel" };
    }
    return undefined; // fall back to acpx's own resolution
  },
});
```

The hook returns:

- a decision (`allow_once`, `allow_always`, `reject_once`, `reject_always`, `cancel`), or
- `{ outcome: "select", optionId }` to pick one of the agent's advertised options by id — useful for adapter-specific options that do not map onto the four standard kinds. An id the agent did not offer is treated as `cancel` rather than being approximated by a similar option.
- `undefined` to decline, which hands the request back to the normal policy-then-mode resolution.

Throwing is equivalent to returning `undefined`: the error is logged and acpx resolves the request itself, so a broken host UI cannot take down the turn.

The `ctx` argument carries:

| Field    | Meaning                                                                                   |
| -------- | ----------------------------------------------------------------------------------------- |
| `signal` | Aborts when the session is cancelled. Long-running review UIs should honor it.            |
| `mode`   | The permission mode governing this request.                                               |
| `policy` | The permission policy governing this request, if one is configured. Frozen and read-only. |

`mode` and `policy` are a snapshot taken when the request arrived, and the same snapshot settles the request if the hook returns `undefined` — so a decision is never judged against settings the hook was not shown. A field is present exactly when acpx has a value for it.

### Observing escalations

A host that does not answer requests itself still needs to know when a policy handed one back. `onPermissionEscalation` fires for every `escalate` or `defer` match that reaches the non-interactive path:

```ts
const runtime = createAcpRuntime({
  // ...
  permissionPolicy: { defer: ["execute"] },
  onPermissionEscalation: (event) => {
    // event.action is "escalate" or "defer"; event.matchedRule names the rule.
    reviewQueue.push(event);
  },
});
```

Without it these requests are invisible: an escalation is not a turn event, does not fail the turn, and carries no separate stat, so the turn completes normally with the tool call denied.

## Exit code 5

If, by the end of a prompt, every permission request was denied or cancelled and none were approved, `acpx` exits with code `5` (`PERMISSION_DENIED`). This makes the "agent could not do anything because permissions were locked down" case detectable from a wrapping script.

If at least one request was approved (auto or explicit), exit code is whatever the prompt result indicates — typically `0` for success, `1` for an agent/runtime error.

## Sandboxing with `--cwd`

`--cwd <dir>` sets the working directory the agent operates in. The ACP `fs/*` and `terminal/*` client methods that `acpx` implements honor cwd boundaries — adapters cannot escape that directory through `fs/read_text_file` or terminal calls routed through the client.

```bash
acpx --cwd ~/repos/api --approve-all codex 'fix everything you find'
```

## `--no-terminal`

Disables the ACP terminal capability for newly-spawned agent clients:

```bash
acpx --no-terminal codex exec 'summarize without spawning shell tools'
```

`acpx` advertises `clientCapabilities.terminal: false` during ACP `initialize`. Agents that respect the advertised capability will avoid terminal calls; agents that do not will get a hard error if they try.

This is a cleaner way to forbid shell access than blanket-denying every permission prompt, because the agent knows the capability is unavailable up front and can plan around it.

## Authentication

Permissions and auth are separate. ACP `authenticate` handshakes are configured through:

- `ACPX_AUTH_<METHOD_ID>` environment variables, e.g. `ACPX_AUTH_OPENAI_API_KEY=sk-…`
- Config `auth` map (see [Config](config.md#authentication))

Ambient provider env vars like `OPENAI_API_KEY` are still passed through to child agents, but they do **not** trigger ACP auth-method selection on their own. This avoids surprise login flows in adapters such as `codex-acp`.

## Permission flags in flows

Flow definitions can declare required permissions. If a flow needs `approve-all` and you run it without `--approve-all`, `acpx` fails fast before the flow starts and tells you which flag to pass.

```bash
# pr-triage example requires --approve-all
acpx --approve-all flow run examples/flows/pr-triage/pr-triage.flow.ts \
  --input-json '{"repo":"openclaw/acpx","prNumber":150}'
```

See [Flows](flows.md#permissions) for how flow permission requirements work.

## Practical patterns

Read-only audit:

```bash
acpx --deny-all codex 'analyze this code without touching anything'
```

Trusted CI run:

```bash
acpx --approve-all --non-interactive-permissions fail \
     codex exec 'apply formatter and run lint'
```

Local exploration with the default safety net:

```bash
# Default --approve-reads, prompts in TTY for writes
acpx codex 'investigate why the build is slow'
```

## See also

- [CLI reference](CLI.md#permission-modes) — full table.
- [Config](config.md) — `defaultPermissions`, `nonInteractivePermissions`.
- [Sessions](sessions.md) — how `--cwd` becomes part of the scope key.
