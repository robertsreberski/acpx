/** Monotonic request ownership guard for latest-response-wins state. */
export class RequestGeneration {
  #current = 0;

  begin(): number {
    this.#current += 1;
    return this.#current;
  }

  isLatest(generation: number): boolean {
    return generation === this.#current;
  }

  invalidate(): void {
    this.#current += 1;
  }
}
