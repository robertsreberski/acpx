---
title: ACPX Console
description: Run the standalone web console for browsing, creating, adopting, and controlling ACPX coding sessions.
---

`acpx-console` is a separate web product for ACPX sessions. It shows every
local conversation in one workspace, streams the complete transcript, and lets
an operator send the next prompt or answer a parked permission or elicitation.

The console is inspired by good operator-console patterns, but it has no
dependency on mono-agent and does not need a mono-agent process. ACPX remains
the owner of session records, queue owners, transcripts, turns, and pending
requests; the console is a browser and trusted local server over those public
APIs.

## Install and start

After its first independent release, install the console package separately
from the `acpx` CLI:

```bash
npm install -g acpx-console
acpx-console start --open
```

The server listens on `127.0.0.1:4174` by default. It stays in the foreground
unless `--detach` is supplied.

```bash
acpx-console start --detach
acpx-console status
acpx-console stop
```

Configuration lives at `~/.acpx/console.json`. Runtime metadata and bounded
service logs live under `~/.acpx/console/`. Stopping the console only stops its
web server. It does not cancel turns, close sessions, or terminate ACPX queue
owners.

## The workspace

The session rail groups conversations by the action they need:

- **Needs you** — a permission or elicitation is waiting for an answer.
- **Working** — a turn is starting, running, queued, cancelling, or otherwise
  active.
- **Open** — the session is open but has no active turn.
- **History** — closed sessions and completed conversations.

Selecting a session opens its assistant-style transcript. Normal assistant
text remains visible, while settled reasoning, plans, tool calls, results, and
operational events are complete but collapsed. Active work expands while it is
streaming. Use **Load earlier** to page backward through long conversations;
the browser does not need to load the whole history at once.

New session events are durably sequenced. Sessions created before this event
ledger existed expose the history ACPX still retained and show a visible
legacy-history gap. The console never labels unavailable history as complete.

## Session state

The console does not compress different failure modes into a single status.
It displays these axes independently:

- Session: `open` or `closed`.
- Owner: `absent`, `starting`, `online`, `unreachable`, or `dead`.
- Turn: `idle`, `queued`, `starting`, `running`, `waiting_permission`,
  `waiting_elicitation`, `cancelling`, `completed`, `failed`, `cancelled`,
  `interrupted`, or `unknown`.
- Queue depth and pending-request states.

An online owner does not imply that a turn is running. A pending request does
not become answerable merely because its durable record still exists: ACPX
checks the exact queue owner before accepting an answer.

## Send and queue prompts

When a session is idle, the composer action is **Send prompt**. When a turn is
already active or waiting for a person, it becomes **Queue follow-up**. A
queued prompt starts after the current turn settles; it does not steer or
modify the active turn.

Every submit receives a durable turn receipt before queue admission. Retrying
the same browser mutation uses the same idempotency key and returns the
original receipt. ACPX guarantees exactly-once local admission, not
exactly-once execution by an external agent. If an owner dies after dispatch,
the turn becomes `interrupted` or `unknown` and is never replayed
automatically.

**Cancel turn** cooperatively cancels only the active turn. **Close session**
is a separate action and does not masquerade as cancel or deletion.

## Answer requests

Permissions and form elicitations appear at their chronological position in
the transcript and in the session's pending-request list.

- Permission cards expose every option supplied by the agent, plus **Decline**
  and **Cancel**.
- Elicitation cards render fields from the requested schema and expose
  **Accept**, **Decline**, and **Cancel**.

The card submits through the same queue-aware answer path as
[`acpx respond`](deferred-requests.md). A refusal or failed delivery leaves the
request visible with an actionable error; the console never invents an answer.

## Create a session

Choose **New session**, then select:

- a registered ACP agent
- a workspace under one of the server's allowed workspace roots
- an optional session name
- an exact mode ID
- an optional exact model ID

Creating a session sends ACP `session/new` but does not automatically send a
prompt. Browser-created sessions use a conservative default policy: read and
search operations may proceed, while writes, command execution, and mode
changes are deferred for a person. Codex starts in `read-only`; Claude starts
in `default`. Those two mode fields may be left blank to use the safe default.
Other agents require an explicit mode rather than inheriting an `approve-all`
project setting silently. The console does not invent mode or model catalogs;
enter exact IDs understood by the selected agent.

## Adopt an existing provider session

Choose **Adopt session**, select an agent, and browse the provider sessions it
advertises. If the adapter cannot list sessions, enter the exact provider
session ID manually. Enter the exact mode ID to apply; Codex and Claude may use
the same safe defaults as fresh sessions.

Adoption uses ACP `session/resume` or `session/load`. It never falls back to a
fresh `session/new`, because that would present an empty conversation as the
session the operator selected. If the provider session cannot be resumed, the
operation fails clearly. Adopting a provider session that ACPX already maps
opens the existing local session instead of duplicating it.

## Mode caveat for a warm owner

Set a session's mode before its first prompt. An already-warm owner can retain
an adapter session at the old mode while an out-of-turn `set-mode` updates only
the stored preference. For Codex that can mean the retained `agent` mode
self-approves work and produces no parked request.

If a warm session must change mode, answer or cancel anything parked, retire
the owner, and let the next prompt bind a fresh adapter session. See
[Deferred requests](deferred-requests.md#the-flow) for the full consequence and
recovery procedure.

## Network trust and security

ACPX Console has **no application login**. Localhost is the safe default. Every
browser that can reach a non-loopback console has full authority to read
transcripts, send prompts, cancel turns, answer requests, and close sessions.

To listen beyond localhost, opt in explicitly:

```bash
acpx-console start \
  --host 0.0.0.0 \
  --trust-network \
  --allowed-host console.example.internal \
  --workspace-root ~/work
```

`--trust-network` means the network is the access-control boundary. Use a
private LAN or tailnet and do not expose the console directly to the public
internet. A wildcard bind also requires at least one explicit `--allowed-host`.
Network mode keeps a persistent warning visible.

The server still applies defense in depth:

- explicit Host allowlisting
- same-origin, Fetch Metadata, and CSRF checks on mutations
- no permissive CORS
- strict content security policy, frame denial, and `nosniff`
- sanitized Markdown with raw HTML disabled
- request-size limits and opaque server-side error details
- realpath-checked workspace selection within configured roots

Workspace roots constrain what the browser may select. They do not replace the
external coding agent's sandbox or permission system.

## Product boundary

ACPX Console is for sessions, not workflow orchestration. Its first version
does not implement Plan to Execute to Review stages, agent teams, arbitrary
browser-supplied agent commands, environment or MCP editing, attachments, or
live steering of a running turn.

The browser also does not maintain a second conversation database. ACPX
session storage and the append-only event ledger are authoritative; browser
state is a disposable projection that can be rebuilt after a console restart.

For applications that need the same backend contract without this UI, use the
public [`acpx/sessions`](https://github.com/robertsreberski/acpx/blob/fork-main/docs/2026-08-12-acpx-console-architecture.md#public-acpxsessions-service)
service.

## Product verification

Two standalone smoke lanes exercise the shipped boundaries without a global
install:

```bash
pnpm run smoke:console:package
pnpm run smoke:console:product
```

The package smoke packs and installs both packages into an isolated prefix.
The product smoke builds the workspace artifacts, starts the detached console
against a temporary home, configuration, workspace, and state directory, then
drives the HTTP and SSE contracts through session creation, live transcript
updates, queued turns, cancellation, permission and elicitation answers, queue
owner recovery, console restart, persisted history, and session close. Cleanup
is bounded to the console, queue owner, and mock-agent processes created by the
smoke.
