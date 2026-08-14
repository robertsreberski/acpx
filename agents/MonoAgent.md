# mono-agent

mono-agent exposes each running configured source as an ACP stdio agent:

```bash
mono-agent bridge acp --source-id personal-agent
```

The source id selects the agent identity: its workspace, instructions, model and
effort configuration, credentials, tools, MCP servers, sandbox, memory, and
conversation history. It is not an ACP model id. Keep model selection in
`mono-agent.config.json` rather than passing acpx `--model` or `--effort` flags.

## Configure an acpx alias

mono-agent is intentionally not a built-in acpx keyword. Add an ordinary
structured-argv alias to `~/.acpx/config.json` or the project's `.acpxrc.json`:

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

Use `mcpServers: []` in project config when it needs to replace a non-empty
global list. The selected mono-agent owns its MCP configuration and rejects
client-injected servers. Confirm the merged result before creating a session:

```bash
acpx config show
mono-agent bridge acp --discover
```

The alias is then a normal acpx agent command:

```bash
acpx mono-personal sessions new
acpx mono-personal "continue the task"
acpx mono-personal status
```

The complete `argv` is part of acpx's agent command identity. Changing
`--source-id` therefore selects a different acpx session scope without adding a
mono-agent-specific routing convention.

## Session continuity

Current mono-agent bridges advertise ACP `session/resume`. acpx persists the
opaque provider session id and uses it to reconnect after its bridge subprocess
or the selected mono-agent source restarts. mono-agent binds that id to the
exact source and authoritative workspace in an owner-only durable registry.

acpx still scopes its local session record by the invocation `cwd`, agent
command, and optional session name. The `cwd` sent over ACP is advisory to
mono-agent, but changing acpx's `cwd` selects a different local record. Use a
stable `--cwd` when an orchestrator must reconnect from another process:

```bash
acpx --cwd /absolute/task/root mono-personal sessions new --name research
acpx --cwd /absolute/task/root mono-personal -s research "continue"
```

Resume fails closed when the id is unknown, corrupt, belongs to another source
or workspace, predates mono-agent's durable registry, or was revoked by
`mono-agent restart --clear-sessions`. acpx does not silently replace that
conversation; run `sessions new` only when a fresh conversation is intended.

## AskUser and deferred elicitation

mono-agent maps `AskUser` to ACP form elicitation. acpx advertises form support
only when the queue owner starts with `--defer`, so use that option on the first
prompt that can ask for input:

```bash
acpx --defer mono-personal --no-wait "inspect the task and ask before choosing a risky path"
acpx mono-personal requests --json
acpx mono-personal respond <request-id> --field question_1=approve
```

`--defer` is fixed for the lifetime of a warm queue owner. If an existing owner
was started without it, let that owner retire or close and recreate the acpx
session before starting the deferred turn. Without form support, mono-agent
cancels the blocked run and reports `interaction_required`; acpx never invents
an answer.

## Ownership boundary

- acpx owns local session lookup, queueing, cancellation, request parking, and
  output formatting.
- mono-agent owns the selected source's workspace, model, instructions, tools,
  MCP, credentials, sandbox, memory, and conversation execution.
- Client filesystem and terminal capabilities may be advertised normally, but
  mono-agent does not call them. It executes only through its configured tools.
- Non-empty client MCP lists and additional workspace directories are rejected.
- `session/load` is not advertised. Resume continues the same conversation
  without replaying its transcript through ACP.
