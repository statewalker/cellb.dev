import type { InputGate } from "./gates.js";
import type { DurableObjectId } from "./id.js";
import type { DurableObjectStorage } from "./storage.js";

/** `ctx` passed to a Durable Object constructor. */
export class DurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  readonly #gate: InputGate;
  readonly #waitUntil: (p: Promise<unknown>) => void;

  readonly #onBlockFailure: (e: unknown) => void;
  constructor(
    id: DurableObjectId,
    storage: DurableObjectStorage,
    gate: InputGate,
    waitUntil: (p: Promise<unknown>) => void,
    onBlockFailure: (e: unknown) => void = () => {},
  ) {
    this.#onBlockFailure = onBlockFailure;
    this.id = id;
    this.storage = storage;
    this.#gate = gate;
    this.#waitUntil = waitUntil;
  }
  /** No event is delivered to the object until `fn` settles. */
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#gate.runClosed(fn);
    // A failure resets the object even when the caller (typically the
    // constructor) does not await the promise; the rejection is then observed.
    p.catch((e) => this.#onBlockFailure(e));
    return p;
  }
  waitUntil(p: Promise<unknown>): void {
    this.#waitUntil(p);
  }
}
