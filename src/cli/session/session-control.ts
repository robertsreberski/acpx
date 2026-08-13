import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { splitCommandLine } from "../../acp/client-process.js";
import { effortStateFromConfigOptions } from "../../acp/effort-support.js";
import { applyConfigOptionsToRecord } from "../../session/config-options.js";
import { cloneSessionAcpxState } from "../../session/conversation-model.js";
import {
  reconcileDesiredEffortForModelChange,
  setCurrentModelId,
  setDesiredConfigOption,
  setDesiredEffort,
  setDesiredModeId,
  setDesiredModelId,
} from "../../session/mode-preference.js";
import {
  clearDesiredEffortAfterUnrefreshedModelChange,
  currentModelIdFromSetModelResponse,
} from "../../session/model-application.js";
import { advertisedModelState } from "../../session/model-state.js";
import { resolveSessionRecord, writeSessionRecord, isoNow } from "../../session/persistence.js";
import type {
  SessionRecord,
  SessionSetConfigOptionResult,
  SessionSetModelResult,
  SessionSetModeResult,
} from "../../types.js";
import {
  isProcessAlive,
  terminateProcess,
  terminateQueueOwnerForSession,
  tryCancelOnRunningOwner,
  tryApplySessionPreferencesOnRunningOwner,
  tryCloseSessionOnRunningOwner,
  trySetConfigOptionOnRunningOwner,
  trySetModelOnRunningOwner,
  trySetModeOnRunningOwner,
} from "../queue/ipc.js";
import type {
  SessionCancelOptions,
  SessionCancelResult,
  SessionApplyPreferencesOptions,
  SessionSetConfigOptionOptions,
  SessionSetModelOptions,
  SessionSetModeOptions,
} from "./contracts.js";
import {
  runSessionApplyPreferencesDirect,
  runSessionSetConfigOptionDirect,
  runSessionSetModelDirect,
  runSessionSetModeDirect,
} from "./prompt-runner.js";

const execFileAsync = promisify(execFile);

export async function cancelSessionPrompt(
  options: SessionCancelOptions,
): Promise<SessionCancelResult> {
  const cancelled = await tryCancelOnRunningOwner(options);
  return {
    sessionId: options.sessionId,
    cancelled: cancelled === true,
  };
}

export async function setSessionMode(
  options: SessionSetModeOptions,
): Promise<SessionSetModeResult> {
  const submittedToOwner = await trySetModeOnRunningOwner(
    options.sessionId,
    options.modeId,
    options.timeoutMs,
    options.verbose,
  );
  if (submittedToOwner) {
    const record = await resolveSessionRecord(options.sessionId);
    setDesiredModeId(record, options.modeId);
    await writeSessionRecord(record);
    return {
      record,
      resumed: false,
    };
  }

  return await runSessionSetModeDirect({
    sessionRecordId: options.sessionId,
    modeId: options.modeId,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
}

export async function setSessionModel(
  options: SessionSetModelOptions,
): Promise<SessionSetModelResult> {
  const submittedToOwner = await trySetModelOnRunningOwner(
    options.sessionId,
    options.modelId,
    options.timeoutMs,
    options.verbose,
  );
  if (submittedToOwner) {
    const record = await resolveSessionRecord(options.sessionId);
    const previousState = cloneSessionAcpxState(record.acpx);
    applyConfigOptionsToRecord(record, submittedToOwner.response);
    setDesiredModelId(record, options.modelId, advertisedModelState(record.acpx)?.configId);
    setCurrentModelId(
      record,
      currentModelIdFromSetModelResponse(submittedToOwner.response, options.modelId),
    );
    if (submittedToOwner.response) {
      record.acpx = reconcileDesiredEffortForModelChange(previousState, record.acpx).state;
    } else {
      record.acpx = clearDesiredEffortAfterUnrefreshedModelChange({
        state: record.acpx,
        modelResponse: submittedToOwner.response,
        previousModelId: advertisedModelState(previousState)?.currentModelId,
        requestedModelId: options.modelId,
        previousEffortConfigId: effortStateFromConfigOptions(previousState?.config_options)
          ?.configId,
      });
    }
    await writeSessionRecord(record);
    return {
      record,
      response: submittedToOwner.response,
      resumed: false,
    };
  }

  return await runSessionSetModelDirect({
    sessionRecordId: options.sessionId,
    modelId: options.modelId,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
}

export async function applySessionPreferences(
  options: SessionApplyPreferencesOptions,
): Promise<SessionSetConfigOptionResult> {
  const ownerResult = await tryApplySessionPreferencesOnRunningOwner({
    sessionId: options.sessionId,
    modelId: options.modelId,
    effort: options.effort,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
  if (ownerResult) {
    const record = await resolveSessionRecord(options.sessionId);
    const previousEffortConfigId = effortStateFromConfigOptions(
      record.acpx?.config_options,
    )?.configId;
    const modelConfigId = advertisedModelState(record.acpx)?.configId;
    applyConfigOptionsToRecord(record, ownerResult.response);
    if (options.modelId) {
      setDesiredModelId(record, options.modelId, modelConfigId);
      setCurrentModelId(
        record,
        currentModelIdFromSetModelResponse(ownerResult.response, options.modelId),
      );
    }
    if (previousEffortConfigId && previousEffortConfigId !== ownerResult.effortConfigId) {
      setDesiredConfigOption(record, previousEffortConfigId, undefined);
    }
    setDesiredEffort(record, options.effort, ownerResult.effortConfigId);
    await writeSessionRecord(record);
    return {
      record,
      response: ownerResult.response,
      resumed: false,
    };
  }

  const result = await runSessionApplyPreferencesDirect({
    sessionRecordId: options.sessionId,
    modelId: options.modelId,
    effort: options.effort,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
    onModelWarning: options.onModelWarning,
  });
  return {
    record: result.record,
    response: result.response,
    resumed: result.resumed,
    loadError: result.loadError,
  };
}

async function applyPortableEffortIfAdvertised(
  options: SessionSetConfigOptionOptions,
): Promise<SessionSetConfigOptionResult | undefined> {
  const storedRecord = await resolveSessionRecord(options.sessionId);
  const portableEffortConfigId = effortStateFromConfigOptions(
    storedRecord.acpx?.config_options,
  )?.configId;
  if (options.configId !== portableEffortConfigId) {
    return undefined;
  }

  return await applySessionPreferences({
    sessionId: options.sessionId,
    effort: options.value,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
}

async function applyOwnerConfigOptionResult(params: {
  options: SessionSetConfigOptionOptions;
  response: SessionSetConfigOptionResult["response"];
}): Promise<SessionSetConfigOptionResult> {
  const { options, response } = params;
  const record = await resolveSessionRecord(options.sessionId);
  const previousState = cloneSessionAcpxState(record.acpx);
  const modelConfigId = advertisedModelState(record.acpx)?.configId;
  applyConfigOptionsToRecord(record, response);
  const effortConfigId = effortStateFromConfigOptions(record.acpx?.config_options)?.configId;
  if (options.configId === modelConfigId) {
    setDesiredModelId(record, options.value, options.configId);
    setCurrentModelId(record, currentModelIdFromSetModelResponse(response, options.value));
    record.acpx = reconcileDesiredEffortForModelChange(previousState, record.acpx).state;
  } else if (options.configId === "mode") {
    setDesiredModeId(record, options.value);
  } else if (options.configId === effortConfigId) {
    setDesiredEffort(record, options.value, options.configId);
  } else {
    setDesiredConfigOption(record, options.configId, options.value);
  }
  await writeSessionRecord(record);
  return {
    record,
    response,
    resumed: false,
  };
}

export async function setSessionConfigOption(
  options: SessionSetConfigOptionOptions,
): Promise<SessionSetConfigOptionResult> {
  const portableEffortResult = await applyPortableEffortIfAdvertised(options);
  if (portableEffortResult) {
    return portableEffortResult;
  }

  const ownerResponse = await trySetConfigOptionOnRunningOwner(
    options.sessionId,
    options.configId,
    options.value,
    options.timeoutMs,
    options.verbose,
  );
  if (ownerResponse) {
    return await applyOwnerConfigOptionResult({ options, response: ownerResponse });
  }

  return await runSessionSetConfigOptionDirect({
    sessionRecordId: options.sessionId,
    configId: options.configId,
    value: options.value,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    fs: options.fs,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
}

function firstAgentCommandToken(command: string): string | undefined {
  try {
    const parsed = splitCommandLine(command);
    return parsed.command || undefined;
  } catch {
    return undefined;
  }
}

async function isLikelyMatchingProcess(pid: number, agentCommand: string): Promise<boolean> {
  const expectedToken = firstAgentCommandToken(agentCommand);
  if (!expectedToken) {
    return false;
  }

  const argv = await readProcessArgv(pid);
  if (argv.length === 0) {
    return false;
  }

  const executableBase = path.basename(argv[0]);
  const expectedBase = path.basename(expectedToken);
  return (
    executableBase === expectedBase || argv.some((entry) => path.basename(entry) === expectedBase)
  );
}

async function readProcessArgv(pid: number): Promise<string[]> {
  const procArgv = await readProcCmdline(pid);
  if (procArgv) {
    return procArgv;
  }

  const commandLine =
    process.platform === "win32"
      ? await readWindowsCommandLine(pid)
      : await readPosixCommandLine(pid);
  return splitCommandLineLike(commandLine);
}

async function readProcCmdline(pid: number): Promise<string[] | undefined> {
  try {
    const payload = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
    return payload
      .split("\u0000")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } catch {
    return undefined;
  }
}

async function readPosixCommandLine(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readWindowsCommandLine(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ],
      { windowsHide: true },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function splitCommandLineLike(commandLine: string | undefined): string[] {
  if (!commandLine) {
    return [];
  }
  try {
    const parsed = splitCommandLine(commandLine);
    return [parsed.command, ...parsed.args];
  } catch {
    return commandLine
      .split(/\s+/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
}

export const sessionControlTestInternals = { firstAgentCommandToken, splitCommandLineLike };

export async function closeSession(sessionId: string): Promise<SessionRecord> {
  const record = await resolveSessionRecord(sessionId);
  await tryCloseSessionOnRunningOwner({ sessionId: record.acpxRecordId }).catch(() => {
    // Preserve local close semantics even if best-effort ACP session shutdown fails.
  });
  await terminateQueueOwnerForSession(record.acpxRecordId);

  if (
    record.pid != null &&
    isProcessAlive(record.pid) &&
    (await isLikelyMatchingProcess(record.pid, record.agentCommand))
  ) {
    await terminateProcess(record.pid);
  }

  record.pid = undefined;
  record.closed = true;
  record.closedAt = isoNow();
  await writeSessionRecord(record);

  return record;
}
