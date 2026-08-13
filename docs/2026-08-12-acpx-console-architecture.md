---
title: ACPX Console Architecture
description: Standalone product, session-service, event-ledger, transport, and security architecture for ACPX Console.
author: OpenClaw Team <dev@openclaw.ai>
date: 2026-08-12
---

## Decision

ACPX Console is a separate product in this repository, published and operated
independently from the `acpx` CLI. It is not a screen inside another agent
framework and has no mono-agent dependency.

```text
browser
  -> acpx-console REST and SSE server
  -> public acpx/sessions service
  -> session records, event ledger, queue owner, pending requests
  -> ACP adapter over stdio
```

ACPX owns the durable state and queue semantics. The console owns HTTP,
browser projection, operator interactions, and its own service lifecycle. It
does not fork a second runtime manager or talk directly to an adapter process.

## Package boundary

The root package continues to publish the ACPX CLI and its embedding APIs. The
console is a workspace package with its own package metadata, executable,
version, frontend build, tests, and production dependencies. It starts at
`acpx-console@0.1.0` and is not tied to the root package's release number.

The console consumes only public ACPX exports. It must not import
`src/cli/**`, queue-owner internals, persistence repositories, or raw store
paths. Those are implementation details behind `acpx/sessions`.

The product is independently releasable. Installing or upgrading `acpx` does
not silently install or start the console, and stopping the console does not
affect ACPX queue owners.

## Public `acpx/sessions` service

`createAcpxSessionService()` is the queue-aware application boundary. The
service returns DTOs rather than live clients, raw `SessionRecord` values,
environment variables, credentials, or mutable internal objects.

The public capability groups are:

- `listAgents`
- `listSessions` and `getSession`, with exact `acpxRecordId` identity
- `listProviderSessions`
- `createSession` and `adoptSession`
- `enqueuePrompt`, `cancelTurn`, and `closeSession`
- `listPendingRequests` and `respondToPendingRequest`
- cursor-based transcript reads and invalidation subscriptions

Every mutation takes an idempotency key. Reusing the key for the same
operation and input returns the stored result. Reusing it for a different
operation or input is a conflict. Idempotency receipts are durable across
console and queue-owner restarts. Replayable results remain for seven days and
at least the latest 512 terminal actions. Compacted SHA-256 key tombstones are
kept exactly for another 30 days; they have no false positives, and their
sharded bounded indexes expire automatically. Session pruning retires every
receipt tied to the record before deleting it, so an old create or adopt key
cannot replay a phantom pruned session.

Creation performs `session/new` only. Adoption performs strict
`session/resume` or `session/load`; it must not replace a missing provider
session with a new one. The service mediates existing queue-owner IPC, so a web
request cannot bypass deferred-request handling or compete with the owner for
the adapter connection.

V1 does not mechanically route the existing CLI handlers through this service.
The CLI remains a compatibility surface over the same persistence, timeline,
queue IPC, pending-request, and error-classification primitives. Until those
handlers converge, overlapping behavior is a parity obligation: exact record
and turn identity, tagged pending answers, queue admission (including unknown
outcomes), owner generation, permission policy, and cancellation must retain
the same meaning on CLI and embedding surfaces. Contract tests at those shared
primitives are the defense against semantic drift; later CLI convergence may
delegate to the service without changing the external CLI contract.

## Identity and state

The stable external identity is `acpxRecordId`. Provider session IDs and
adapter process IDs may change after reconnect and are not browser route keys.
Suffix or fuzzy session matching is not exposed over HTTP.

Service-created records use a collision-safe local `acpxRecordId` independent
of the adapter-scoped provider session ID. Adoption persists the registered
agent identity with that mapping: command upgrades for the same agent keep the
record, while the same adapter-scoped provider ID from a different agent gets a
separate local record rather than returning or overwriting the wrong transcript.

State is a product of independent axes:

```text
session: open | closed
owner:   absent | starting | online | unreachable | dead
turn:    idle | queued | starting | running
       | waiting_permission | waiting_elicitation | cancelling
       | completed | failed | cancelled | interrupted | unknown
queue:   non-negative queued prompt count plus unresolved turn id, submitted-at,
         and optional display text for each currently queued prompt
```

Session summaries merge the durable pending-request ledger with the live queue
owner's in-memory waiter set. The owner read is bounded, and reads for separate
sessions run concurrently, so one slow owner does not turn a session listing
into an unbounded serial wait. A live-only waiter can exist when its durable
write failed; when the owner answers, it remains authoritative for both the
pending count and the `waiting_permission` or `waiting_elicitation` state. If a
live owner cannot answer within the bound, the durable ledger is retained as a
safe lower bound rather than killing or reconciling the owner during a read.

The service allocates and persists a `turnId` before attempting queue
admission. A successful mutation therefore returns a stable receipt even when
the turn has not started. An ambiguous post-write transport result is returned
as an `unknown` receipt on the first call; exact-key replay returns the same
turn without another submit, while a fresh key deliberately denotes a new user
action. The guarantee is exactly-once local admission. ACPX
does not promise exactly-once external-agent execution after an ambiguous
process failure.

The submitted lifecycle envelope also retains browser-safe prompt display text.
Session projection combines unresolved submissions with the live owner's queue
depth, so reloading the console reconstructs the exact queued rows and their
cancellation targets instead of relying on browser memory. Older envelopes
without text remain readable, and owner loss never turns stale submissions into
apparently cancellable work.

Session close has two explicit outcomes in one receipt: the local record is
durably closed, and provider close is either `confirmed` or `degraded` with a
coarse, non-sensitive reason. Provider failure never rolls back the local
close, but it is also never collapsed into an apparent complete success.

No automatic recovery may replay a turn that could already have reached the
agent. Owner loss after dispatch settles the local turn as `interrupted` or
`unknown` and requires an operator decision.

## Event ledger and complete history

New session activity is appended to one file per epoch:
`~/.acpx/sessions/<encoded-record-id>.timeline.<epoch>.ndjson`. The envelope
schema is `acpx.session_event.v1`; record-level timeline metadata uses
`acpx.session_timeline.v1`.

Each event contains `acpx_record_id`, `epoch`, a monotonic `seq`,
`captured_at`, `direction` (`inbound`, `outbound`, or `internal`), optional
`turn_id` and `request_id`, and one of these payloads:

- `{ kind: "acp", message: <raw JSON-RPC> }`
- `{ kind: "lifecycle", event: <typed turn event> }`

The ledger is the console transcript source. The bounded `SessionRecord`
message projection remains useful for quick CLI summaries, and legacy
`.stream.ndjson` files remain compatibility artifacts, but neither can support
a promise of complete history.

Epoch files are append-only, are never rotated or deleted automatically, and
are retained until explicit session pruning includes history. Transcript APIs
page by opaque base64url cursors bound to the exact record, epoch, and
sequence. An invalid cursor returns `CURSOR_INVALID`. A cursor for an expired
epoch returns `CURSOR_EXPIRED` plus `earliestCursor` rather than restarting
silently.

`listSessionTimelinePage(recordId, { cursor, limit })` returns the newest window
when no cursor is supplied, with events chronological within each page. Its
`previousCursor` pages backward to older windows. Existing sessions are
imported from the raw history that ACPX still retains. Their oldest page
carries an `acpx.session_history_gap.v1` item with reason `legacy_retained`, and
their coverage is also `legacy_retained`. Missing pre-ledger content is never
synthesized.

## Console transport

The server exposes versioned JSON routes for bootstrap, session inventory,
session detail, timeline pages, turns, pending requests, adoption, and close.
Mutations require an `Idempotency-Key` header.

Server-Sent Events carry bounded invalidations and transcript-head cursors,
not a second authoritative transcript. The browser fetches a snapshot, pages
history over REST, and refetches affected resources after invalidation.
`Last-Event-ID` resumes within the bounded replay window; a `reset` event asks
the browser to refresh authoritative state when replay is no longer available.

This deliberately favors a recoverable one-way live transport. Browser input
is ordinary idempotent HTTP rather than an unacknowledged WebSocket command.

## Browser projection

The frontend uses an external-store assistant runtime fed by ACPX transcript
pages. It preserves chronological order across assistant text, reasoning,
tools, lifecycle events, permissions, and form elicitations.

Settled technical activity is collapsed without being discarded. Active
activity expands while streaming. Unknown ACP events remain inspectable as
raw JSON so protocol additions do not vanish merely because the current UI
does not recognize them.

The composer reflects turn state:

- **Send prompt** admits a turn on an idle session.
- **Queue follow-up** records the next prompt while the current turn is active
  or waiting.
- Pending permissions and forms are answered at their transcript cards.
- **Cancel turn** cooperatively targets the current turn.

There is no live-steering claim. A queued message never edits the prompt an
agent is already executing.

## Creation, adoption, and policy

Browser session creation is limited to registered agents and realpath-resolved
workspace roots configured by the operator. The browser cannot supply an
arbitrary adapter command, environment, credential, or filesystem path.

The default policy auto-approves reads and searches, then defers writes,
execution, and mode changes. Codex starts at `read-only`; Claude starts at
`default`. An unknown agent must receive an explicit safe choice. Project
configuration must not silently broaden a browser-created session to
approve-all.

Provider adoption is paginated when the adapter implements `session/list`.
Manual exact provider-ID entry is the fallback. Duplicate adoption resolves to
the existing ACPX mapping. Resume/load failure is a visible terminal error.

Mode preferences are durable across a new owner binding, but setting a mode
against an already-warm idle owner has a known caveat: its retained adapter
session may remain at the old mode. The console must surface the actionable
conflict and must not claim the stored preference proves the effective mode.

## Threat model

There is intentionally no application login. Loopback is the default boundary.
Binding a non-loopback address requires `--trust-network`, which declares that
network reachability itself grants full operator authority.

That authority includes reading transcripts and tool details, sending prompts,
answering permission and form requests, cancelling turns, and closing
sessions. The server must keep the risk visible and should be deployed only on
a private LAN or tailnet.

Defense in depth remains required:

- exact Host allowlist
- Origin, Fetch Metadata, and CSRF checks for every mutation
- CORS disabled by default
- strict CSP, frame denial, and MIME sniffing protection
- sanitized Markdown with raw HTML disabled
- bounded request bodies, connections, and SSE replay
- safe error projection without secrets or local stack traces
- realpath containment for browser-selectable workspace roots, including
  symlink escape rejection
- same-user private control socket for service shutdown, not an HTTP endpoint

Workspace containment controls browser selection only. It does not claim to
sandbox the external agent. ACPX permission policy and the adapter's sandbox
remain separate security boundaries.

## Service lifecycle

The executable supports foreground and detached start, status, and stop. The
default address is `127.0.0.1:4174`; non-loopback start is refused without the
explicit trust flag, and wildcard binds also require an explicit allowed Host
value.

Configuration is stored under `~/.acpx/console.json`. PID/control metadata and
bounded service logs use `~/.acpx/console/`. Lifecycle commands distinguish
an already-running instance from stale metadata, and `status` proves the
actual process and health endpoint rather than trusting a PID file alone.

The control plane owns only the web process. A restart reconstructs browser
projections from the ACPX session service and never mutates conversation state
as part of startup recovery.

## Verification contract

The product is not complete based on component snapshots alone. The required
proof follows each stateful boundary:

- Timeline tests cover sequence recovery, concurrent appends, opaque cursors,
  wrong-record and wrong-epoch refusal, legacy gaps, explicit history pruning,
  and retention across close or console restart.
- Session-service tests cover exact-record lookup, strict adoption, durable
  idempotency replay and conflict, owner-generation changes, queued admission,
  cancellation, pending-request answers, and ambiguous owner loss without
  duplicate execution.
- CLI/service parity tests cover their shared queue wire, exact turn
  cancellation, tagged pending answers, and admission-error classification;
  V1 does not claim that legacy CLI handlers delegate through the service.
- Mock-agent integration covers create, adopt, streaming transcript updates,
  queue-next ordering, cancellation, permissions, elicitations, owner restart,
  console restart, and session close.
- HTTP tests cover Host, Origin, Fetch Metadata, CSRF, idempotency headers, body
  limits, Markdown/XSS handling, traversal, symlink escape, and non-loopback
  refusal without the trust flag.
- Browser tests cover keyboard interaction, focus restoration, history paging,
  sticky auto-follow, gap markers, responsive navigation, and request cards at
  320, 390, 768, and 1280 pixels.
- `node scripts/smoke-acpx-console-package.mjs` builds and packs both products,
  installs their tarballs outside the checkout, then proves the installed
  binary's version/help, detached start, health/bootstrap routes, status, stop,
  and cleanup.

One safe real-adapter smoke should finally prove a streaming turn and a
deferred request through the installed console. Release, global installation,
and live deployment remain separate explicit operations.

## Non-goals

The first product version does not own:

- Plan to Execute to Review workflow enforcement
- agent orchestration or teams
- arbitrary browser-supplied adapter commands
- environment, credential, MCP, or registry editing
- attachments
- live mid-turn steering
- automatic replay of ambiguous turns
- a second conversation database
- public-internet authentication

These boundaries keep the product a focused human console for ACPX sessions
rather than a second orchestration framework.
