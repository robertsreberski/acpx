import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { QueueConnectionError } from "../../errors.js";

export type QueueOwnerTurnState = "idle" | "starting" | "active" | "closing";

export type AppliedSessionPreferences = {
  effortConfigId: string;
  response: SetSessionConfigOptionResponse;
};

export type QueueOwnerActiveSessionController = {
  hasActivePrompt: () => boolean;
  requestCancelActivePrompt: () => Promise<boolean>;
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionModel: (modelId: string) => Promise<SetSessionConfigOptionResponse | undefined>;
  setSessionConfigOption: (
    configId: string,
    value: string,
  ) => Promise<SetSessionConfigOptionResponse>;
  applySessionPreferences: (
    modelId: string | undefined,
    effort: string,
  ) => Promise<AppliedSessionPreferences>;
};

type QueueOwnerTurnControllerOptions = {
  withTimeout: <T>(run: () => Promise<T>, timeoutMs?: number) => Promise<T>;
  setSessionModeFallback: (modeId: string, timeoutMs?: number) => Promise<void>;
  setSessionModelFallback: (
    modelId: string,
    timeoutMs?: number,
  ) => Promise<SetSessionConfigOptionResponse | undefined>;
  setSessionConfigOptionFallback: (
    configId: string,
    value: string,
    timeoutMs?: number,
  ) => Promise<SetSessionConfigOptionResponse>;
  applySessionPreferencesFallback: (
    modelId: string | undefined,
    effort: string,
    timeoutMs?: number,
  ) => Promise<AppliedSessionPreferences>;
};

export class QueueOwnerTurnController {
  private readonly options: QueueOwnerTurnControllerOptions;
  private state: QueueOwnerTurnState = "idle";
  private pendingCancel = false;
  private activeController?: QueueOwnerActiveSessionController;
  private controlTargetReady?: Promise<void>;
  private resolveControlTargetReady?: () => void;

  constructor(options: QueueOwnerTurnControllerOptions) {
    this.options = options;
  }

  get lifecycleState(): QueueOwnerTurnState {
    return this.state;
  }

  get hasPendingCancel(): boolean {
    return this.pendingCancel;
  }

  beginTurn(): void {
    this.state = "starting";
    this.pendingCancel = false;
    this.startControlTargetWait();
  }

  markPromptActive(): void {
    if (this.state === "starting" || this.state === "active") {
      this.state = "active";
    }
  }

  endTurn(): void {
    this.state = "idle";
    this.pendingCancel = false;
    this.finishControlTargetWait();
  }

  beginClosing(): void {
    this.state = "closing";
    this.pendingCancel = false;
    this.activeController = undefined;
    this.finishControlTargetWait();
  }

  setActiveController(controller: QueueOwnerActiveSessionController): void {
    this.activeController = controller;
    this.finishControlTargetWait();
  }

  clearActiveController(): void {
    this.activeController = undefined;
    if (this.state === "starting" || this.state === "active") {
      this.startControlTargetWait();
    }
  }

  private startControlTargetWait(): void {
    this.finishControlTargetWait();
    this.controlTargetReady = new Promise((resolve) => {
      this.resolveControlTargetReady = resolve;
    });
  }

  private finishControlTargetWait(): void {
    this.resolveControlTargetReady?.();
    this.resolveControlTargetReady = undefined;
    this.controlTargetReady = undefined;
  }

  private async waitForActiveControllerOrIdle(timeoutMs?: number): Promise<void> {
    if (this.activeController || this.state === "idle") {
      return;
    }
    const ready = this.controlTargetReady;
    if (ready) {
      await this.options.withTimeout(async () => await ready, timeoutMs);
    }
    this.assertCanHandleControlRequest();
  }

  private assertCanHandleControlRequest(): void {
    if (this.state === "closing") {
      throw new QueueConnectionError("Queue owner is closing", {
        detailCode: "QUEUE_OWNER_SHUTTING_DOWN",
        origin: "queue",
        retryable: true,
      });
    }
  }

  async requestCancel(): Promise<boolean> {
    const activeController = this.activeController;
    if (activeController?.hasActivePrompt()) {
      const cancelled = await activeController.requestCancelActivePrompt();
      if (cancelled) {
        this.pendingCancel = false;
      }
      return cancelled;
    }

    if (this.state === "starting" || this.state === "active") {
      this.pendingCancel = true;
      return true;
    }

    return false;
  }

  async applyPendingCancel(): Promise<boolean> {
    const activeController = this.activeController;
    if (!this.pendingCancel || !activeController || !activeController.hasActivePrompt()) {
      return false;
    }

    const cancelled = await activeController.requestCancelActivePrompt();
    if (cancelled) {
      this.pendingCancel = false;
    }
    return cancelled;
  }

  async setSessionMode(modeId: string, timeoutMs?: number): Promise<void> {
    this.assertCanHandleControlRequest();
    const activeController = this.activeController;
    if (activeController) {
      await this.options.withTimeout(
        async () => await activeController.setSessionMode(modeId),
        timeoutMs,
      );
      return;
    }

    await this.options.setSessionModeFallback(modeId, timeoutMs);
  }

  async setSessionModel(
    modelId: string,
    timeoutMs?: number,
  ): Promise<SetSessionConfigOptionResponse | undefined> {
    this.assertCanHandleControlRequest();
    const activeController = this.activeController;
    if (activeController) {
      return await this.options.withTimeout(
        async () => await activeController.setSessionModel(modelId),
        timeoutMs,
      );
    }

    return await this.options.setSessionModelFallback(modelId, timeoutMs);
  }

  async setSessionConfigOption(
    configId: string,
    value: string,
    timeoutMs?: number,
  ): Promise<SetSessionConfigOptionResponse> {
    this.assertCanHandleControlRequest();
    const activeController = this.activeController;
    if (activeController) {
      return await this.options.withTimeout(
        async () => await activeController.setSessionConfigOption(configId, value),
        timeoutMs,
      );
    }

    return await this.options.setSessionConfigOptionFallback(configId, value, timeoutMs);
  }

  async applySessionPreferences(
    modelId: string | undefined,
    effort: string,
    timeoutMs?: number,
  ): Promise<AppliedSessionPreferences> {
    this.assertCanHandleControlRequest();
    await this.waitForActiveControllerOrIdle(timeoutMs);
    const activeController = this.activeController;
    if (activeController) {
      return await this.options.withTimeout(
        async () => await activeController.applySessionPreferences(modelId, effort),
        timeoutMs,
      );
    }

    return await this.options.applySessionPreferencesFallback(modelId, effort, timeoutMs);
  }
}
