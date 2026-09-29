/** Defers to a macrotask (portable: browser, Worker, Node, Deno). */
export const nextMacrotask = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Input gate: while any storage operation is in flight, no new event is
 * delivered to the object. Unlike Miniflare 2 it needs no AsyncLocalStorage:
 * each object owns its gate and storage captures it by closure.
 *
 * Release is deferred to a macrotask so the continuation of the operation
 * that held the gate runs before the next event (the read-modify-write
 * guarantee), and waiters are woken ONE at a time, re-checking the gate.
 */
export class InputGate {
  #locks = 0;
  #waiters: (() => void)[] = [];
  #draining = false;

  get isOpen(): boolean {
    return this.#locks === 0;
  }
  async waitOpen(): Promise<void> {
    while (this.#locks > 0) await new Promise<void>((r) => this.#waiters.push(r));
  }
  /** Calls `cb` synchronously at the moment the gate is (re)opened for it. */
  onOpen(cb: () => void): void {
    if (this.#locks === 0 && !this.#draining) cb();
    else this.#waiters.push(cb);
  }
  lock(): void {
    this.#locks++;
  }
  unlock(): void {
    setTimeout(() => {
      this.#locks--;
      void this.#drain();
    }, 0);
  }
  async runClosed<T>(fn: () => T | Promise<T>): Promise<T> {
    this.lock();
    try {
      return await fn();
    } finally {
      this.unlock();
    }
  }
  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#locks === 0 && this.#waiters.length) {
        this.#waiters.shift()!();
        await nextMacrotask();
      }
    } finally {
      this.#draining = false;
    }
  }
}

/**
 * Output gate: tracks durability promises of local commits. Responses and
 * outgoing messages are released only once every commit that happened
 * before them is durable. A failed commit breaks the object.
 */
export class OutputGate {
  #pending = new Set<Promise<void>>();
  #failure: unknown = undefined;

  track(p: Promise<void>): void {
    const tracked = p.then(
      () => void this.#pending.delete(tracked),
      (err) => {
        this.#pending.delete(tracked);
        this.#failure ??= err;
      },
    );
    this.#pending.add(tracked);
  }
  get failure(): unknown {
    return this.#failure;
  }
  /** Resolves when everything committed so far is durable; rejects if any failed. */
  async barrier(): Promise<void> {
    while (this.#pending.size) await Promise.all([...this.#pending]);
    if (this.#failure !== undefined) throw this.#failure;
  }
}
