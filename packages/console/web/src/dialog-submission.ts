import { RequestGeneration } from "./request-generation";

/** Own one dialog opening's async mutation and reject late completions. */
export class DialogSubmission {
  readonly #requests = new RequestGeneration();
  #pending = false;

  get pending(): boolean {
    return this.#pending;
  }

  begin(): number {
    this.#pending = true;
    return this.#requests.begin();
  }

  complete(generation: number): boolean {
    if (!this.#requests.isLatest(generation)) {
      return false;
    }
    this.#pending = false;
    return true;
  }

  dismiss(): boolean {
    if (this.#pending) {
      return false;
    }
    this.#requests.invalidate();
    return true;
  }

  replace(): void {
    this.#requests.invalidate();
    this.#pending = false;
  }
}
