import { Command, InvalidArgumentError } from "commander";
import { PendingRequestOwnerGoneError } from "../errors.js";
import {
  listPendingRequestSessionIds,
  listPendingRequests,
  readPendingRequest,
  serializePendingRequestForDisk,
  sweepPendingRequests,
  type PendingRequest,
  type PendingRequestAnswer,
} from "../session/pending-requests.js";
import type { OutputFormat } from "../types.js";
import { findRoutedSessionOrThrow } from "./command-handlers.js";
import type { ResolvedAcpxConfig } from "./config.js";
import {
  addSessionNameOption,
  parseNonEmptyValue,
  resolveAgentInvocation,
  resolveGlobalFlags,
  resolveSessionNameFromFlags,
} from "./flags.js";
import { tryListRequestsOnRunningOwner, tryRespondOnRunningOwner } from "./queue/ipc.js";
import { readQueueOwnerStatus } from "./queue/lease-store.js";

export type RequestsListFlags = {
  all?: boolean;
  json?: boolean;
  session?: string;
};

export type RespondFlags = {
  option?: string;
  decline?: boolean;
  cancel?: boolean;
  json?: boolean;
  session?: string;
};

/**
 * Owner generation used when no owner is alive. Real generations are positive
 * integers, so this matches nothing: sweeping with it is what turns every entry
 * a dead owner left pending into an orphan.
 */
const NO_LIVE_OWNER_GENERATION = 0;

function resolveRequestsFormat(
  json: boolean | undefined,
  globalFormat: OutputFormat,
): OutputFormat {
  return json === true ? "json" : globalFormat;
}

/** Exactly one answer arm; anything else is a usage error, never a guess. */
function resolveAnswerFromFlags(flags: RespondFlags): PendingRequestAnswer {
  const chosen = [flags.option !== undefined, flags.decline === true, flags.cancel === true].filter(
    Boolean,
  ).length;
  if (chosen !== 1) {
    throw new InvalidArgumentError(
      "Answer a request with exactly one of --option <optionId>, --decline, or --cancel",
    );
  }
  if (flags.option !== undefined) {
    return { type: "select", option_id: flags.option };
  }
  return flags.decline === true ? { type: "decline" } : { type: "cancel" };
}

/**
 * The generation of the owner that is alive right now, or the sentinel when
 * there is none. Reading the lease (rather than asking the owner) is what keeps
 * this working when the owner is wedged, which is exactly when an operator
 * reaches for these verbs.
 */
async function liveOwnerGeneration(sessionId: string): Promise<number> {
  const owner = await readQueueOwnerStatus(sessionId);
  return owner?.ownerGeneration ?? NO_LIVE_OWNER_GENERATION;
}

function sortedRequests(entries: PendingRequest[]): PendingRequest[] {
  return entries.toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.requestId.localeCompare(right.requestId),
  );
}

/**
 * Requests the owner is holding that the store does not know about.
 *
 * The manager records a park before registering the waiter but tolerates a
 * write failure rather than stranding the agent, so a live owner can be blocked
 * on a request that has no file. Those are additive: nothing the store reports
 * is overruled here, because only the owning owner may rewrite its entries.
 */
function mergeLiveParkedRequests(
  stored: PendingRequest[],
  live: PendingRequest[],
): PendingRequest[] {
  const known = new Set(stored.map((entry) => entry.requestId));
  return [...stored, ...live.filter((entry) => !known.has(entry.requestId))];
}

async function readLiveParkedRequests(
  sessionId: string,
  warn: (message: string) => void,
): Promise<PendingRequest[]> {
  try {
    return (await tryListRequestsOnRunningOwner({ sessionId })) ?? [];
  } catch (error) {
    // The durable store is the answer to this question; the owner only adds to
    // it. Failing the whole listing because the owner is busy would break the
    // command in the situation it exists for, but the gap is never silent.
    warn(
      `could not read live parked requests from the queue owner for session ${sessionId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

async function reconcileSessionRequests(sessionId: string): Promise<PendingRequest[]> {
  // Never reimplement the orphan rule: the sweep owns it, including the proof
  // that the recorded owner is gone.
  await sweepPendingRequests({ sessionId, ownerGeneration: await liveOwnerGeneration(sessionId) });
  return await listPendingRequests(sessionId);
}

async function listSessionRequests(
  sessionId: string,
  warn: (message: string) => void,
): Promise<PendingRequest[]> {
  const stored = await reconcileSessionRequests(sessionId);
  return sortedRequests(
    mergeLiveParkedRequests(stored, await readLiveParkedRequests(sessionId, warn)),
  );
}

/**
 * Every session in the store. This one stays store-only: a cross-session scan
 * has no single session context, and a request no session directory knows about
 * would not be discoverable here anyway.
 */
async function listAllRequests(): Promise<PendingRequest[]> {
  const entries: PendingRequest[] = [];
  for (const sessionId of await listPendingRequestSessionIds()) {
    entries.push(...(await reconcileSessionRequests(sessionId)));
  }
  return sortedRequests(entries);
}

function requestOptionSummary(entry: PendingRequest): string {
  return entry.options.map((option) => option.optionId).join("|") || "-";
}

function printRequestsByFormat(entries: PendingRequest[], format: OutputFormat): void {
  if (format === "json") {
    // The persisted store shape, verbatim: one versioned contract for the file
    // on disk, the queue wire, and this listing.
    process.stdout.write(`${JSON.stringify(entries.map(serializePendingRequestForDisk))}\n`);
    return;
  }

  if (format === "quiet") {
    for (const entry of entries) {
      process.stdout.write(`${entry.requestId}\n`);
    }
    return;
  }

  if (entries.length === 0) {
    process.stdout.write("No parked requests\n");
    return;
  }

  for (const entry of entries) {
    process.stdout.write(
      `${entry.requestId}\t${entry.state}\t${entry.toolCall.title}\t${requestOptionSummary(entry)}\t${entry.createdAt}\n`,
    );
  }
}

function printRespondResultByFormat(entry: PendingRequest, format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(serializePendingRequestForDisk(entry))}\n`);
    return;
  }

  if (format === "quiet") {
    process.stdout.write(`${entry.state}\n`);
    return;
  }

  const selected = entry.resolution?.optionId ? ` (${entry.resolution.optionId})` : "";
  process.stdout.write(`${entry.state}${selected}: ${entry.requestId}\n`);
}

function createWarn(jsonStrict: boolean | undefined): (message: string) => void {
  return (message: string) => {
    if (jsonStrict !== true) {
      process.stderr.write(`[acpx] warning: ${message}\n`);
    }
  };
}

export async function handleRequestsList(
  explicitAgentName: string | undefined,
  flags: RequestsListFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const format = resolveRequestsFormat(flags.json, globalFlags.format);
  const sessionName = resolveSessionNameFromFlags(flags, command);
  if (flags.all === true) {
    if (sessionName !== undefined) {
      // Naming a session and asking for every session are contradictory; doing
      // one of them silently would hide which.
      throw new InvalidArgumentError("--all cannot be combined with -s/--session");
    }
    printRequestsByFormat(await listAllRequests(), format);
    return;
  }

  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const record = await findRoutedSessionOrThrow(
    agent.agentCommand,
    agent.agentName,
    agent.cwd,
    sessionName,
  );
  printRequestsByFormat(
    await listSessionRequests(record.acpxRecordId, createWarn(globalFlags.jsonStrict)),
    format,
  );
}

/**
 * Reconcile the session, then describe why the answer cannot land.
 *
 * The sweep is what marks entries the dead owner left pending as orphaned; it
 * is also the only writer allowed to, and only because the generation proves
 * the owner is gone.
 */
async function orphanAndRefuseAnswer(params: {
  sessionId: string;
  requestId: string;
  liveGeneration: number;
  detail: string;
}): Promise<PendingRequestOwnerGoneError> {
  await sweepPendingRequests({
    sessionId: params.sessionId,
    ownerGeneration: params.liveGeneration,
  });
  return new PendingRequestOwnerGoneError(
    `Request ${params.requestId} can no longer be answered: ${params.detail}. ` +
      `Pending requests left behind on session ${params.sessionId} were marked orphaned.`,
  );
}

/**
 * A parked request can only be answered by the process that is blocked on it.
 * When that owner is gone the waiter died with it, so the entry is reconciled
 * to `orphaned` and the caller is told, rather than being left to believe an
 * answer is still possible.
 *
 * A request with no stored entry is left to the owner to judge: the owner is
 * the only process that knows what it is actually holding.
 */
async function assertAnswerableByLiveOwner(sessionId: string, requestId: string): Promise<void> {
  const liveGeneration = await liveOwnerGeneration(sessionId);
  const stored = await readPendingRequest(sessionId, requestId);
  const answerable =
    liveGeneration !== NO_LIVE_OWNER_GENERATION &&
    (stored === undefined || stored.ownerGeneration === liveGeneration);
  if (answerable) {
    return;
  }

  throw await orphanAndRefuseAnswer({
    sessionId,
    requestId,
    liveGeneration,
    detail:
      stored && liveGeneration !== NO_LIVE_OWNER_GENERATION
        ? `it was parked by owner generation ${stored.ownerGeneration}, and generation ${liveGeneration} owns the session now`
        : "its queue owner is no longer running",
  });
}

export async function handleRespond(
  explicitAgentName: string | undefined,
  requestId: string,
  flags: RespondFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const format = resolveRequestsFormat(flags.json, globalFlags.format);
  const answer = resolveAnswerFromFlags(flags);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const record = await findRoutedSessionOrThrow(
    agent.agentCommand,
    agent.agentName,
    agent.cwd,
    resolveSessionNameFromFlags(flags, command),
  );
  const sessionId = record.acpxRecordId;

  await assertAnswerableByLiveOwner(sessionId, requestId);
  const answered = await tryRespondOnRunningOwner({
    sessionId,
    pendingRequestId: requestId,
    answer,
    verbose: globalFlags.verbose,
  });
  if (!answered) {
    // The owner released its lease between the check above and the call.
    throw await orphanAndRefuseAnswer({
      sessionId,
      requestId,
      liveGeneration: await liveOwnerGeneration(sessionId),
      detail: "its queue owner stopped before the answer reached it",
    });
  }

  printRespondResultByFormat(answered, format);
}

function addRequestsListOptions(command: Command): Command {
  addSessionNameOption(command);
  return command
    .option("--all", "List parked requests for every session, not just this one")
    .option("--json", "Alias for --format json");
}

export function registerRequestsCommands(
  parent: Command,
  explicitAgentName: string | undefined,
  config: ResolvedAcpxConfig,
  descriptions: { requests: string; respond: string },
): void {
  const requestsCommand = parent.command("requests").description(descriptions.requests);
  addRequestsListOptions(requestsCommand);
  requestsCommand.action(async function (this: Command, flags: RequestsListFlags) {
    await handleRequestsList(explicitAgentName, flags, this, config);
  });

  addRequestsListOptions(requestsCommand.command("list"))
    .description("List parked requests")
    .action(async function (this: Command, flags: RequestsListFlags) {
      await handleRequestsList(explicitAgentName, flags, this, config);
    });

  const respondCommand = parent
    .command("respond")
    .description(descriptions.respond)
    .argument("<request-id>", "Parked request id", (value: string) =>
      parseNonEmptyValue("Request id", value),
    )
    .option("--option <optionId>", "Answer with an option id the agent offered", (value: string) =>
      parseNonEmptyValue("Option id", value),
    )
    .option("--decline", "Answer with the rejection option the agent offered")
    .option("--cancel", "Cancel the request instead of choosing an option")
    .option("--json", "Alias for --format json");
  addSessionNameOption(respondCommand);
  respondCommand.action(async function (this: Command, requestId: string, flags: RespondFlags) {
    await handleRespond(explicitAgentName, requestId, flags, this, config);
  });
}
