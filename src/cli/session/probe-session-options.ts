import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import { AcpClient } from "../../acp/client.js";
import { withTimeout } from "../../async-control.js";
import { absolutePath } from "../../session/persistence/repository.js";
import type { McpServer } from "../../types.js";

/**
 * Discover the modes and models an agent advertises, without keeping a session.
 *
 * ACP only advertises these on the `session/new` response, so discovery has to
 * open a provider session and then let it go. That has real cost, which shapes
 * every decision here: the probe is strictly non-interactive, bounded by its own
 * timeout, and closes the session it opened whenever the agent supports it.
 *
 * The result is an advisory snapshot, not a contract. Some adapters derive the
 * available modes from the selected model, so a catalog read against the probe
 * session's initial model may not describe a session created with a different
 * one. Session creation still validates what it is given.
 */

export interface ProbeOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export type ProbeCatalog =
  | { readonly advertised: false }
  | {
      readonly advertised: true;
      readonly currentValue?: string;
      readonly options: readonly ProbeOption[];
    };

export type ProbeCleanup = "closed" | "unsupported" | "failed";

export type ProbeSessionOptionsResult =
  | {
      readonly status: "ready";
      readonly modes: ProbeCatalog;
      readonly models: ProbeCatalog;
      readonly cleanup: ProbeCleanup;
      /** Retained when a session was opened but could not be closed, so the stray is traceable. */
      readonly strandedSessionId?: string;
    }
  | {
      readonly status: "failed";
      readonly phase: "start" | "session_new";
      readonly code: "auth_required" | "timeout" | "spawn_failed" | "protocol_error";
      readonly message: string;
      readonly cleanup: ProbeCleanup;
      readonly strandedSessionId?: string;
    };

export interface ProbeSessionOptionsInput {
  readonly agentCommand: string;
  readonly agentArgv?: readonly string[];
  readonly cwd: string;
  readonly mcpServers?: readonly McpServer[];
  readonly authCredentials?: Record<string, string>;
  /**
   * The policy a real session would use. "skip" lets an adapter that manages its
   * own credentials proceed; it does not start an interactive login. Forcing
   * "fail" here would make discovery fail for every self-authenticating agent
   * even though creating a session would have worked.
   */
  readonly authPolicy?: "skip" | "fail";
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

const NOT_ADVERTISED: ProbeCatalog = { advertised: false };

const flattenSelectOptions = (
  options: SessionConfigOption & { type: "select" },
): readonly ProbeOption[] =>
  options.options.flatMap((entry) =>
    "group" in entry ? entry.options.map(selectOption) : [selectOption(entry)],
  );

const selectOption = (option: SessionConfigSelectOption): ProbeOption => ({
  value: option.value,
  label: option.name || option.value,
  ...(option.description ? { description: option.description } : {}),
});

/** Read one category out of the advertised session configuration. */
export const catalogFromConfigOptions = (
  configOptions: readonly SessionConfigOption[] | undefined,
  category: "mode" | "model",
): ProbeCatalog => {
  const option = configOptions?.find(
    (entry) => entry.type === "select" && entry.category === category,
  );
  if (!option || option.type !== "select") {
    return NOT_ADVERTISED;
  }
  const options = flattenSelectOptions(option);
  return options.length > 0
    ? { advertised: true, currentValue: option.currentValue, options }
    : NOT_ADVERTISED;
};

/** Older adapters advertise models through `models` metadata rather than a config option. */
export const catalogFromLegacyModels = (
  models:
    | { currentModelId?: string; availableModels?: { modelId: string; name?: string }[] }
    | undefined,
): ProbeCatalog => {
  const available = models?.availableModels ?? [];
  return available.length > 0
    ? {
        advertised: true,
        currentValue: models?.currentModelId,
        options: available.map((model) => ({
          value: model.modelId,
          label: model.name || model.modelId,
        })),
      }
    : NOT_ADVERTISED;
};

const failureCode = (
  error: unknown,
): "auth_required" | "timeout" | "spawn_failed" | "protocol_error" => {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout/iu.test(message)) {
    return "timeout";
  }
  if (/auth|credential|login|unauthor/iu.test(message)) {
    return "auth_required";
  }
  if (/ENOENT|spawn|not found|command/iu.test(message)) {
    return "spawn_failed";
  }
  return "protocol_error";
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "The agent could not be queried.";

const probeFailure = (
  phase: "start" | "session_new",
  error: unknown,
): ProbeSessionOptionsResult => ({
  status: "failed",
  phase,
  code: failureCode(error),
  message: errorMessage(error),
  cleanup: "unsupported",
});

/**
 * A client that can only look. It denies permission requests, advertises no
 * filesystem or terminal, and authenticates the way a real session would.
 */
const probeClient = (input: ProbeSessionOptionsInput, cwd: string): AcpClient =>
  new AcpClient({
    agentCommand: input.agentCommand,
    agentArgv: input.agentArgv ? [...input.agentArgv] : undefined,
    cwd,
    mcpServers: input.mcpServers ? [...input.mcpServers] : undefined,
    permissionMode: "deny-all",
    nonInteractivePermissions: "deny",
    authCredentials: input.authCredentials,
    authPolicy: input.authPolicy ?? "skip",
    fs: false,
    terminal: false,
  });

const readyResult = (
  created: { sessionId: string; configOptions?: SessionConfigOption[]; models?: unknown },
  cleanup: ProbeCleanup,
): ProbeSessionOptionsResult => {
  const models = catalogFromConfigOptions(created.configOptions, "model");
  return {
    status: "ready",
    modes: catalogFromConfigOptions(created.configOptions, "mode"),
    models: models.advertised
      ? models
      : catalogFromLegacyModels(created.models as Parameters<typeof catalogFromLegacyModels>[0]),
    cleanup,
    ...(cleanup === "failed" ? { strandedSessionId: created.sessionId } : {}),
  };
};

export async function probeSessionOptions(
  input: ProbeSessionOptionsInput,
): Promise<ProbeSessionOptionsResult> {
  const timeoutMs = input.timeoutMs ?? 20_000;
  const cwd = absolutePath(input.cwd);
  const client = probeClient(input, cwd);

  try {
    try {
      await withTimeout(client.start(), timeoutMs);
    } catch (error) {
      return probeFailure("start", error);
    }
    if (input.signal?.aborted) {
      return probeFailure("start", new Error("The probe was cancelled."));
    }

    let created: Awaited<ReturnType<AcpClient["createSession"]>>;
    try {
      created = await withTimeout(client.createSession(cwd), timeoutMs);
    } catch (error) {
      return probeFailure("session_new", error);
    }

    return readyResult(created, await releaseSession(client, created.sessionId));
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Give the discarded session back when the agent can take it. Agents without
 * `session/close` keep it until they expire it themselves, which is why the
 * result says which of those happened rather than claiming success.
 */
const releaseSession = async (client: AcpClient, sessionId: string): Promise<ProbeCleanup> => {
  if (!client.supportsCloseSession()) {
    return "unsupported";
  }
  try {
    await withTimeout(client.closeSession(sessionId), 5_000);
    return "closed";
  } catch {
    return "failed";
  }
};
