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
  private shuttingDown = false;
  private pendingCancel = false;
  private activeTurnId?: string;
  private activeController?: QueueOwnerActiveSessionController;
  private controlTargetReady?: Promise<void>;
  private resolveControlTargetReady?: () => void;
  private idleControlSequence: Promise<void> = Promise.resolve();
  private pendingIdleControls = 0;
  private idleControlsDone?: Promise<void>;
  private resolveIdleControlsDone?: () => void;

  constructor(options: QueueOwnerTurnControllerOptions) {
    this.options = options;
  }

  get lifecycleState(): QueueOwnerTurnState {
    return this.state;
  }

  get hasPendingCancel(): boolean {
    return this.pendingCancel;
  }

  /**
   * Claim the turn before waiting on anything.
   *
   * The dequeue already removed this task from the pending FIFO, and a targeted
   * cancel looks in the FIFO first and at `activeTurnId` second. Anything
   * awaited before the claim therefore opens a window where the turn is in
   * neither place and an exact cancel silently reports "not found" — a window
   * that used to be zero, because starting a turn was synchronous, and that
   * waiting for idle controls would otherwise stretch to the length of a
   * control request. Cancellation also tests the state, so the state has to move
   * with the id rather than after it.
   */
  async beginTurn(turnId?: string): Promise<void> {
    this.assertCanHandleControlRequest();
    this.state = "starting";
    this.pendingCancel = false;
    this.activeTurnId = turnId;
    this.startControlTargetWait();
    try {
      while (this.idleControlsDone) {
        await this.idleControlsDone;
      }
      // Shutdown can begin while idle controls drain.
      this.assertCanHandleControlRequest();
    } catch (error) {
      // The turn never started, so release the claim. A rejected beginTurn
      // never reaches endTurn, and a stale claim would leave a cancel matching
      // a turn that is not running.
      this.state = "idle";
      this.pendingCancel = false;
      this.activeTurnId = undefined;
      this.finishControlTargetWait();
      throw error;
    }
  }

  markPromptActive(): void {
    if (this.state === "starting" || this.state === "active") {
      this.state = "active";
    }
  }

  endTurn(): void {
    this.state = "idle";
    this.pendingCancel = false;
    this.activeTurnId = undefined;
    this.finishControlTargetWait();
  }

  prepareForShutdown(): void {
    this.shuttingDown = true;
    this.finishControlTargetWait();
    this.resolveIdleControlsDone?.();
    this.resolveIdleControlsDone = undefined;
    this.idleControlsDone = undefined;
  }

  beginClosing(): void {
    this.prepareForShutdown();
    this.state = "closing";
    this.pendingCancel = false;
    this.activeTurnId = undefined;
    this.activeController = undefined;
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

  private beginIdleControl(): void {
    if (this.pendingIdleControls === 0) {
      this.idleControlsDone = new Promise((resolve) => {
        this.resolveIdleControlsDone = resolve;
      });
    }
    this.pendingIdleControls += 1;
  }

  private finishIdleControl(): void {
    this.pendingIdleControls -= 1;
    if (this.pendingIdleControls > 0) {
      return;
    }
    this.resolveIdleControlsDone?.();
    this.resolveIdleControlsDone = undefined;
    this.idleControlsDone = undefined;
  }

  private runIdleControl<T>(run: () => Promise<T>): Promise<T> {
    this.beginIdleControl();
    const operation = this.idleControlSequence.then(run);
    this.idleControlSequence = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation.finally(() => this.finishIdleControl());
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
    if (this.shuttingDown || this.state === "closing") {
      throw new QueueConnectionError("Queue owner is closing", {
        detailCode: "QUEUE_OWNER_SHUTTING_DOWN",
        origin: "queue",
        retryable: true,
      });
    }
  }

  async requestCancel(targetTurnId?: string): Promise<boolean> {
    if (targetTurnId !== undefined && targetTurnId !== this.activeTurnId) {
      return false;
    }
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
    while (true) {
      this.assertCanHandleControlRequest();
      const activeController = this.activeController;
      if (activeController) {
        await this.options.withTimeout(
          async () => await activeController.setSessionMode(modeId),
          timeoutMs,
        );
        return;
      }
      if (this.state === "idle") {
        await this.runIdleControl(
          async () => await this.options.setSessionModeFallback(modeId, timeoutMs),
        );
        return;
      }
      await this.waitForActiveControllerOrIdle(timeoutMs);
    }
  }

  async setSessionModel(
    modelId: string,
    timeoutMs?: number,
  ): Promise<SetSessionConfigOptionResponse | undefined> {
    while (true) {
      this.assertCanHandleControlRequest();
      const activeController = this.activeController;
      if (activeController) {
        return await this.options.withTimeout(
          async () => await activeController.setSessionModel(modelId),
          timeoutMs,
        );
      }
      if (this.state === "idle") {
        return await this.runIdleControl(
          async () => await this.options.setSessionModelFallback(modelId, timeoutMs),
        );
      }
      await this.waitForActiveControllerOrIdle(timeoutMs);
    }
  }

  async setSessionConfigOption(
    configId: string,
    value: string,
    timeoutMs?: number,
  ): Promise<SetSessionConfigOptionResponse> {
    while (true) {
      this.assertCanHandleControlRequest();
      const activeController = this.activeController;
      if (activeController) {
        return await this.options.withTimeout(
          async () => await activeController.setSessionConfigOption(configId, value),
          timeoutMs,
        );
      }
      if (this.state === "idle") {
        return await this.runIdleControl(
          async () => await this.options.setSessionConfigOptionFallback(configId, value, timeoutMs),
        );
      }
      await this.waitForActiveControllerOrIdle(timeoutMs);
    }
  }

  async applySessionPreferences(
    modelId: string | undefined,
    effort: string,
    timeoutMs?: number,
  ): Promise<AppliedSessionPreferences> {
    while (true) {
      this.assertCanHandleControlRequest();
      const activeController = this.activeController;
      if (activeController) {
        return await this.options.withTimeout(
          async () => await activeController.applySessionPreferences(modelId, effort),
          timeoutMs,
        );
      }
      if (this.state === "idle") {
        return await this.runIdleControl(
          async () =>
            await this.options.applySessionPreferencesFallback(modelId, effort, timeoutMs),
        );
      }
      await this.waitForActiveControllerOrIdle(timeoutMs);
    }
  }
}
