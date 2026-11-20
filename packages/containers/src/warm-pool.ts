// A pool of single-use instances kept ready: generic over what an instance is (a worker with a
// sandbox, a connection, ...). No dependencies; the same code in browsers and Node.

export interface WarmPoolFactory<T> {
  create(): Promise<T>;
  destroy(instance: T): void | Promise<void>;
}

export interface WarmPoolOptions {
  /** Instances kept ready (idle). */
  size: number;
  /** Instances created at once (creating one is expensive). Default: `size`. */
  maxCreating?: number;
  /** First delay after a failed create; doubles on each consecutive failure, up to 30 s. */
  backoffMs?: number;
  /**
   * Consecutive failed creates after which waiting requests are rejected with the last error
   * (the pool keeps retrying for later requests). Default: 5.
   */
  failAfter?: number;
}

interface Waiter<T> {
  resolve(instance: T): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

/**
 * Keeps `size` single-use instances ready. A request takes one, or waits in line for the next;
 * a replacement starts as soon as one is taken, so the pool is warm again by the time the work
 * ends. Instances are never handed out twice: destroy them after use (use() does).
 */
export class WarmPool<T> {
  readonly #factory: WarmPoolFactory<T>;
  readonly #size: number;
  readonly #maxCreating: number;
  readonly #backoffMs: number;
  readonly #failAfter: number;
  readonly #idle: T[] = [];
  readonly #waiters: Waiter<T>[] = [];
  readonly #readyListeners: (() => void)[] = [];
  #creating = 0;
  #failures = 0;
  #backoff?: ReturnType<typeof setTimeout>;
  #closed = false;

  constructor(factory: WarmPoolFactory<T>, opts: WarmPoolOptions) {
    this.#factory = factory;
    this.#size = Math.max(1, opts.size);
    this.#maxCreating = Math.max(1, opts.maxCreating ?? this.#size);
    this.#backoffMs = opts.backoffMs ?? 250;
    this.#failAfter = Math.max(1, opts.failAfter ?? 5);
    this.#fill();
  }

  /** Instances ready to be taken. */
  get idle(): number {
    return this.#idle.length;
  }

  /** Instances being created. */
  get creating(): number {
    return this.#creating;
  }

  /** Resolves when `size` instances are ready. */
  ready(): Promise<void> {
    if (this.#idle.length >= this.#size || this.#closed) return Promise.resolve();
    return new Promise((resolve) => this.#readyListeners.push(resolve));
  }

  /** Takes a ready instance, or waits for the next one (up to `timeoutMs`). */
  acquire(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("the pool is closed"));
    if (opts.signal?.aborted) return Promise.reject(new Error("aborted"));
    const ready = this.#idle.shift();
    const result = ready !== undefined ? Promise.resolve(ready) : this.#wait(opts);
    this.#fill(); // replace it now: the pool is warm again when the work ends
    return result;
  }

  /** Destroys an instance after use (it is never returned to the pool). */
  async destroy(instance: T): Promise<void> {
    await this.#factory.destroy(instance);
  }

  /** Takes an instance, runs `fn` with it, and destroys it, whatever `fn` does. */
  async use<R>(
    fn: (instance: T) => Promise<R>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<R> {
    const instance = await this.acquire(opts);
    try {
      return await fn(instance);
    } finally {
      void Promise.resolve(this.#factory.destroy(instance)).catch(() => {});
    }
  }

  /** Rejects waiting requests and destroys ready instances (and those still being created). */
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#backoff);
    for (const w of this.#waiters.splice(0))
      this.#settle(w).reject(new Error("the pool is closed"));
    for (const l of this.#readyListeners.splice(0)) l();
    await Promise.allSettled(this.#idle.splice(0).map((i) => this.#factory.destroy(i)));
  }

  #wait(opts: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const w: Waiter<T> = { resolve, reject, signal: opts.signal };
      if (opts.timeoutMs !== undefined)
        w.timer = setTimeout(() => {
          this.#drop(w);
          reject(new Error(`timed out after ${opts.timeoutMs} ms waiting for a ready instance`));
        }, opts.timeoutMs);
      if (opts.signal) {
        w.onAbort = () => {
          this.#drop(w);
          reject(new Error("aborted"));
        };
        opts.signal.addEventListener("abort", w.onAbort, { once: true });
      }
      this.#waiters.push(w);
    });
  }

  #drop(w: Waiter<T>) {
    const i = this.#waiters.indexOf(w);
    if (i >= 0) this.#waiters.splice(i, 1);
    this.#settle(w);
  }

  #settle(w: Waiter<T>) {
    clearTimeout(w.timer);
    if (w.onAbort) w.signal?.removeEventListener("abort", w.onAbort);
    return w;
  }

  // Creates instances until `size` are ready (plus one for each waiting request), at most
  // `maxCreating` at once, and not while backing off after failures.
  #fill() {
    while (
      !this.#closed &&
      !this.#backoff &&
      this.#creating < this.#maxCreating &&
      this.#idle.length + this.#creating < this.#size + this.#waiters.length
    ) {
      this.#creating++;
      let created: Promise<T>;
      try {
        created = this.#factory.create();
      } catch (e) {
        created = Promise.reject(e);
      }
      created.then(
        (instance) => {
          this.#creating--;
          this.#failures = 0;
          this.#offer(instance);
          this.#fill();
        },
        (error: unknown) => {
          this.#creating--;
          this.#failures++;
          if (this.#failures % this.#failAfter === 0) {
            const cause = error instanceof Error ? error.message : String(error);
            const e = new Error(
              `no instance could be created (${this.#failures} failed attempts): ${cause}`,
              { cause: error },
            );
            for (const w of this.#waiters.splice(0)) this.#settle(w).reject(e);
          }
          const delay = Math.min(30_000, this.#backoffMs * 2 ** (this.#failures - 1));
          clearTimeout(this.#backoff);
          this.#backoff = setTimeout(() => {
            this.#backoff = undefined;
            this.#fill();
          }, delay);
        },
      );
    }
  }

  #offer(instance: T) {
    if (this.#closed) {
      void Promise.resolve(this.#factory.destroy(instance)).catch(() => {});
      return;
    }
    const w = this.#waiters.shift();
    if (w) this.#settle(w).resolve(instance);
    else this.#idle.push(instance);
    if (this.#idle.length >= this.#size) for (const l of this.#readyListeners.splice(0)) l();
  }
}
