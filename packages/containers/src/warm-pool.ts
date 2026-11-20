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
}

export class WarmPool<T> {
  constructor(_factory: WarmPoolFactory<T>, _opts: WarmPoolOptions) {}
  get idle(): number {
    throw new Error("not implemented");
  }
  get creating(): number {
    throw new Error("not implemented");
  }
  ready(): Promise<void> {
    throw new Error("not implemented");
  }
  acquire(_opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    throw new Error("not implemented");
  }
  destroy(_instance: T): Promise<void> {
    throw new Error("not implemented");
  }
  use<R>(_fn: (instance: T) => Promise<R>, _opts: { timeoutMs?: number } = {}): Promise<R> {
    throw new Error("not implemented");
  }
  close(): Promise<void> {
    throw new Error("not implemented");
  }
}
