import { Command, InvalidArgumentError } from "commander";
import { PendingRequestOwnerGoneError } from "../errors.js";
import {
  elicitationFieldNames,
  listPendingRequestSessionIds,
  listPendingRequests,
  readPendingRequest,
  serializePendingRequestForDisk,
  sweepPendingRequests,
  type PendingElicitationRequest,
  type PendingRequest,
  type PendingRequestAnswer,
} from "../session/pending-requests.js";
import type { OutputFormat } from "../types.js";
import { findRoutedSessionOrThrow } from "./command-handlers.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { elicitationContentFromFlags } from "./elicitation-answer.js";
import {
  addSessionNameOption,
  parseNonEmptyValue,
  resolveAgentInvocation,
  resolveGlobalFlags,
  resolveSessionNameFromFlags,
} from "./flags.js";
import { tryListRequestsOnRunningOwner, tryRespondOnRunningOwner } from "./queue/ipc.js";
import { readLiveQueueOwner } from "./queue/lease-store.js";

export type RequestsListFlags = {
  all?: boolean;
  json?: boolean;
  session?: string;
};

export type RespondFlags = {
  option?: string;
  field?: string[];
  text?: string;
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

/**
 * How long the live-owner cross-check may take before the listing gives up and
 * reports what the store holds. A suspended or wedged owner accepts the socket
 * connection and then never answers, so an unbounded wait would hang the one
 * command an operator reaches for when a session is stuck.
 */
const LIVE_LIST_TIMEOUT_MS = 2_000;

function resolveRequestsFormat(
  json: boolean | undefined,
  globalFormat: OutputFormat,
): OutputFormat {
  return json === true ? "json" : globalFormat;
}

/** `--field` is repeatable, so each occurrence appends rather than replaces. */
function collectFieldFlag(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), parseNonEmptyValue("Field", value)];
}

/**
 * Which answer the flags name. `--field` may repeat, so the whole group counts
 * as the single `form` arm; `--field` and `--text` together do not, because
 * they are two different ways of saying which field gets the value.
 */
type RespondArm = "option" | "form" | "decline" | "cancel";

function namedRespondArms(flags: RespondFlags): RespondArm[] {
  const named: Array<[RespondArm, boolean]> = [
    ["option", flags.option !== undefined],
    ["form", (flags.field?.length ?? 0) > 0 || flags.text !== undefined],
    ["decline", flags.decline === true],
    ["cancel", flags.cancel === true],
  ];
  return named.filter(([, chosen]) => chosen).map(([arm]) => arm);
}

function resolveRespondArm(flags: RespondFlags): RespondArm {
  const [arm, ...rest] = namedRespondArms(flags);
  if (arm === undefined || rest.length > 0) {
    throw new InvalidArgumentError(
      "Answer a request with exactly one of --option <optionId>, --field <key>=<value> " +
        "(repeatable), --text <answer>, --decline, or --cancel",
    );
  }
  if ((flags.field?.length ?? 0) > 0 && flags.text !== undefined) {
    throw new InvalidArgumentError(
      "--text and --field both name the field being answered; use one or the other",
    );
  }
  return arm;
}

/**
 * The generation of the owner whose process is alive right now, or the sentinel
 * when there is none.
 *
 * `readLiveQueueOwner` is deliberately the non-mutating read: the status helper
 * retires an owner whose heartbeat has gone stale, which for a live-but-busy
 * owner means killing the process that is holding the very promise these verbs
 * exist to answer.
 */
async function liveOwnerGeneration(sessionId: string): Promise<number> {
  return (await readLiveQueueOwner(sessionId))?.ownerGeneration ?? NO_LIVE_OWNER_GENERATION;
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
  if (!(await readLiveQueueOwner(sessionId))) {
    // No live process to ask; the store is the whole answer, and this is what
    // bounds the cross-session listing to sessions that still have an owner.
    return [];
  }
  try {
    return (
      (await tryListRequestsOnRunningOwner({
        sessionId,
        responseTimeoutMs: LIVE_LIST_TIMEOUT_MS,
      })) ?? []
    );
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

/**
 * Listing observes; it never reconciles.
 *
 * Marking an entry `orphaned` is a claim that its owner is gone, and only a
 * caller holding proof of that may make it — the next owner of the session (its
 * generation is the proof) or `respond`, which has just looked for a live
 * process and found none. An inspection command has no such proof: an owner
 * that is merely slow or suspended looks identical from here, and rewriting its
 * parked requests would destroy answers that are still coming.
 */
async function listSessionRequests(
  sessionId: string,
  warn: (message: string) => void,
): Promise<PendingRequest[]> {
  const stored = await listPendingRequests(sessionId);
  return sortedRequests(
    mergeLiveParkedRequests(stored, await readLiveParkedRequests(sessionId, warn)),
  );
}

/**
 * Every session the store knows about, with the same live-owner cross-check.
 *
 * The cross-check is bounded to sessions that still have a live lease, so the
 * cost is one lock-file read per session and an IPC round trip only where there
 * is something to ask. A park whose durable write failed in a session with no
 * other entries has no directory to be discovered through, so it stays
 * invisible here.
 */
async function listAllRequests(warn: (message: string) => void): Promise<PendingRequest[]> {
  const entries: PendingRequest[] = [];
  for (const sessionId of await listPendingRequestSessionIds()) {
    entries.push(...(await listSessionRequests(sessionId, warn)));
  }
  return sortedRequests(entries);
}

/**
 * What this request is asking, in one line.
 *
 * A permission request has a tool title; an elicitation has the agent's own
 * message, which is free text and routinely spans lines — the text listing is
 * one row per request, so it is folded onto a single line here rather than
 * being allowed to break the format.
 */
function requestSubjectSummary(entry: PendingRequest): string {
  if (entry.kind === "elicitation") {
    return entry.elicitation.message.replace(/\s+/g, " ").trim() || "form";
  }
  return entry.toolCall.title;
}

/**
 * What can be answered with: the option ids for a permission request, the form
 * field names for an elicitation. Both are what `respond` needs to be told.
 */
function requestAnswerSummary(entry: PendingRequest): string {
  if (entry.kind === "elicitation") {
    return elicitationFieldNames(entry).join("|") || "-";
  }
  return entry.options.map((option) => option.optionId).join("|") || "-";
}

function printRequestsByFormat(entries: PendingRequest[], format: OutputFormat): void {
  if (format === "json") {
    // The persisted store shape, verbatim: one versioned contract for the file
    // on disk, the queue wire, and this listing.
    process.stdout.write(`${JSON.stringify(entries.map(serializePendingRequestForDisk))}\n`);
    return;
  }

  // Both non-JSON formats carry the session, so a cross-session listing says
  // which session is stuck without a second lookup, and the scoped listing has
  // the same shape.
  if (format === "quiet") {
    for (const entry of entries) {
      process.stdout.write(`${entry.requestId}\t${entry.sessionId}\n`);
    }
    return;
  }

  if (entries.length === 0) {
    // Not "no parked requests": the listing covers settled states too.
    process.stdout.write("No requests\n");
    return;
  }

  for (const entry of entries) {
    process.stdout.write(
      `${entry.requestId}\t${entry.state}\t${entry.sessionId}\t${entry.kind}\t${requestSubjectSummary(entry)}\t${requestAnswerSummary(entry)}\t${entry.createdAt}\n`,
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

/**
 * A listing that could not reach a live owner is a listing that may be short,
 * and a machine consumer is exactly the caller who cannot notice that. The
 * diagnostic is therefore never suppressed, not even under --json-strict, whose
 * contract is that stderr carries no NON-JSON output: in JSON mode it is
 * emitted as an `_acpx/warning` notification, matching the other `_acpx/*`
 * extension notifications acpx already writes.
 *
 * It stays on stderr rather than in the payload because `requests --json` is a
 * bare array of persisted entries, and wrapping it would break the one shape
 * the file on disk, the queue wire, and this listing share.
 */
function createWarn(format: OutputFormat): (message: string) => void {
  return (message: string) => {
    if (format === "json") {
      process.stderr.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "_acpx/warning",
          params: { code: "QUEUE_OWNER_UNREACHABLE", message },
        })}\n`,
      );
      return;
    }
    process.stderr.write(`[acpx] warning: ${message}\n`);
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
    printRequestsByFormat(await listAllRequests(createWarn(format)), format);
    return;
  }

  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const record = await findRoutedSessionOrThrow(
    agent.agentCommand,
    agent.agentName,
    agent.cwd,
    sessionName,
  );
  printRequestsByFormat(await listSessionRequests(record.acpxRecordId, createWarn(format)), format);
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

/**
 * The parked entry a form answer has to be typed against.
 *
 * Only the form arms need this: an option id, a decline and a cancel all mean
 * the same thing without reading the request, and the owner refuses them
 * authoritatively if they turn out not to fit. `--field` and `--text` cannot
 * even be built without the schema, so this reads the store and — only if the
 * store has no entry, which happens when a park's durable write failed — asks
 * the owner that is holding it.
 */
async function readFormRequest(
  sessionId: string,
  requestId: string,
  warn: (message: string) => void,
): Promise<PendingElicitationRequest> {
  const stored =
    (await readPendingRequest(sessionId, requestId)) ??
    (await readLiveParkedRequests(sessionId, warn)).find((entry) => entry.requestId === requestId);
  if (!stored) {
    throw new InvalidArgumentError(
      `Request ${requestId} was not found on session ${sessionId}, and --field/--text can only ` +
        `be typed against the form the agent asked for; list the session's requests first`,
    );
  }
  if (stored.kind !== "elicitation") {
    throw new InvalidArgumentError(
      `Request ${requestId} is a permission request, not a form; answer it with ` +
        `--option <optionId>, --decline or --cancel`,
    );
  }
  return stored;
}

async function resolveRespondAnswer(params: {
  arm: RespondArm;
  flags: RespondFlags;
  sessionId: string;
  requestId: string;
  warn: (message: string) => void;
}): Promise<PendingRequestAnswer> {
  switch (params.arm) {
    case "option":
      return { type: "select", option_id: params.flags.option ?? "" };
    case "decline":
      return { type: "decline" };
    case "cancel":
      return { type: "cancel" };
    default: {
      const entry = await readFormRequest(params.sessionId, params.requestId, params.warn);
      return { type: "accept", content: elicitationContentFromFlags(entry, params.flags) };
    }
  }
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
  // Resolved before anything else so a malformed answer is a usage error that
  // costs no lookups, exactly as it was before forms existed.
  const arm = resolveRespondArm(flags);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const record = await findRoutedSessionOrThrow(
    agent.agentCommand,
    agent.agentName,
    agent.cwd,
    resolveSessionNameFromFlags(flags, command),
  );
  const sessionId = record.acpxRecordId;

  await assertAnswerableByLiveOwner(sessionId, requestId);
  const answer = await resolveRespondAnswer({
    arm,
    flags,
    sessionId,
    requestId,
    warn: createWarn(format),
  });
  const answered = await tryRespondOnRunningOwner({
    sessionId,
    pendingRequestId: requestId,
    answer,
    // Opt-in only: --timeout is how every other verb bounds its wait, and
    // without it an answer in flight is worth waiting for indefinitely.
    ...(globalFlags.timeout === undefined ? {} : { responseTimeoutMs: globalFlags.timeout }),
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

/**
 * Let commander's own usage errors (an empty option value, a missing argument)
 * propagate instead of exiting the process itself.
 *
 * Commander's default exit code for those is 1, which acpx assigns to runtime
 * and delivery failures — so a typo and an undelivered answer were
 * indistinguishable to a caller. Rethrowing routes them through the CLI's error
 * handler, which maps a usage error to exit 2 and renders it in the requested
 * output format.
 */
function rethrowUsageErrors(command: Command): Command {
  return command.exitOverride();
}

function addRequestsListOptions(command: Command): Command {
  addSessionNameOption(command);
  return rethrowUsageErrors(command)
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

  const respondCommand = rethrowUsageErrors(parent.command("respond"))
    .description(descriptions.respond)
    .argument("<request-id>", "Parked request id", (value: string) =>
      parseNonEmptyValue("Request id", value),
    )
    .option("--option <optionId>", "Answer with an option id the agent offered", (value: string) =>
      parseNonEmptyValue("Option id", value),
    )
    .option(
      "--field <key=value>",
      "Fill in one field of an elicitation form; repeat for more",
      collectFieldFlag,
    )
    .option("--text <answer>", "Fill in an elicitation form that has exactly one field")
    .option("--decline", "Decline: the agent's rejection option, or a declined form")
    .option("--cancel", "Cancel the request instead of answering it")
    .option("--json", "Alias for --format json");
  addSessionNameOption(respondCommand);
  respondCommand.action(async function (this: Command, requestId: string, flags: RespondFlags) {
    await handleRespond(explicitAgentName, requestId, flags, this, config);
  });
}
