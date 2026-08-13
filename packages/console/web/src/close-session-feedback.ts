import type { CloseSessionResult, ConsoleNotice } from "./types";

export interface CloseSessionFeedback {
  readonly message: string;
  readonly tone: ConsoleNotice["tone"];
}

export const closeSessionFeedback = (result: CloseSessionResult): CloseSessionFeedback =>
  result.providerClose.status === "confirmed"
    ? { message: "Session closed.", tone: "success" }
    : {
        message:
          "Session closed locally, but the provider did not confirm shutdown. Check the agent process before assuming it stopped.",
        tone: "info",
      };
