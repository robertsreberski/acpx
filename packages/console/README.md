# ACPX Console

ACPX Console is the standalone web workspace for local ACPX coding sessions.
It lists session and owner state, follows complete transcripts in real time,
queues prompts, cancels active turns, and answers deferred permissions or form
elicitations.

It is a separate product from the `acpx` CLI and has no mono-agent dependency.
ACPX session records, event timelines, queue owners, and pending requests
remain authoritative; the browser is a disposable projection over the public
`acpx/sessions` service.

## Status

`acpx-console` starts at version `0.1.0` and is independently releasable. The
commands below describe post-release usage; a source checkout is not evidence
that the package has been published or deployed.

Fork root releases use `vX.Y.Z-fork.N` and publish `acpx` under the non-default
`fork` npm tag. After that exact dependency is registry-visible,
`console-vX.Y.Z` independently publishes `acpx-console`; root releases never
implicitly republish the console.

Because npm requires a package to exist before trusted publishing can be
configured, the first console release is an explicit bootstrap: dispatch the
Release workflow for the existing console tag with `bootstrap_console` enabled
and a one-time, granular `NPM_TOKEN`. Immediately configure `acpx-console` to
trust `release.yml` in `robertsreberski/acpx`, then remove the secret. Later
console releases reject bootstrap mode and use GitHub OIDC.

## Install and run

After release:

```bash
npm install -g acpx-console
acpx-console start --open
```

The default listener is `127.0.0.1:4174`. The process stays in the foreground
unless `--detach` is supplied.

```bash
acpx-console start --detach
acpx-console status
acpx-console stop
```

Stopping the console stops only its web process. It does not cancel turns,
close sessions, or terminate ACPX queue owners.

## Network boundary

There is no application login. Every browser that can reach the server has
full session-control authority. Non-loopback binding therefore requires
`--trust-network`, and wildcard binding also requires an explicit Host
allowlist.

```bash
acpx-console start \
  --host 0.0.0.0 \
  --trust-network \
  --allowed-host console.example.internal \
  --workspace-root ~/work
```

Use only a trusted private LAN or tailnet. Workspace roots restrict what the
browser may select; they do not replace the coding agent's sandbox.

## Product boundary

The console owns a browser UI, a small REST/SSE server, and foreground or
detached service lifecycle. It does not own workflow stages, agent teams,
arbitrary adapter commands, environment or MCP editing, attachments, or live
mid-turn steering.

For the complete operator guide, see
[`docs/console.md`](https://github.com/robertsreberski/acpx/blob/fork-main/docs/console.md).
For architecture and the public session contract, see
[`docs/2026-08-12-acpx-console-architecture.md`](https://github.com/robertsreberski/acpx/blob/fork-main/docs/2026-08-12-acpx-console-architecture.md).

## Development

From the repository root:

```bash
pnpm --filter acpx-console typecheck
pnpm --filter acpx-console test
pnpm --filter acpx-console build
node scripts/smoke-acpx-console-package.mjs
```

The smoke helper packs both `acpx` and `acpx-console`, installs them under a
temporary npm prefix, exercises the installed binary and HTTP service, then
stops the exact process it started. It never performs a global install.

## License and attribution

MIT. See [`LICENSE`](LICENSE). The interface is independently implemented for
this repository and does not copy GPL mono-agent web-console source.

The browser runtime uses the MIT-licensed assistant-ui packages. Their
attribution is recorded in [`NOTICE`](NOTICE).
