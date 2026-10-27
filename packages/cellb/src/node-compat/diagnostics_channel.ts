/**
 * `node:diagnostics_channel` for browsers (nodejs_compat): named channels with subscribers,
 * enough for libraries that publish to them (the Agents SDK publishes its events this way).
 */
type Listener = (message: unknown, name: string | symbol) => void;

export class Channel {
  readonly #listeners = new Set<Listener>();
  constructor(readonly name: string | symbol) {}
  get hasSubscribers(): boolean {
    return this.#listeners.size > 0;
  }
  subscribe(listener: Listener): void {
    this.#listeners.add(listener);
  }
  unsubscribe(listener: Listener): boolean {
    return this.#listeners.delete(listener);
  }
  publish(message: unknown): void {
    for (const l of this.#listeners) {
      try {
        l(message, this.name);
      } catch (e) {
        // As Node: a failing subscriber does not fail the publisher.
        queueMicrotask(() => {
          throw e;
        });
      }
    }
  }
  runStores<T>(
    _data: unknown,
    fn: (...args: unknown[]) => T,
    thisArg?: unknown,
    ...args: unknown[]
  ): T {
    return fn.apply(thisArg, args);
  }
}

const channels = new Map<string | symbol, Channel>();

export function channel(name: string | symbol): Channel {
  let c = channels.get(name);
  if (!c) {
    c = new Channel(name);
    channels.set(name, c);
  }
  return c;
}
export const hasSubscribers = (name: string | symbol) => channel(name).hasSubscribers;
export const subscribe = (name: string | symbol, l: Listener) => channel(name).subscribe(l);
export const unsubscribe = (name: string | symbol, l: Listener) => channel(name).unsubscribe(l);

export default { Channel, channel, hasSubscribers, subscribe, unsubscribe };
