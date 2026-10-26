/** `node:diagnostics_channel` for browsers (nodejs_compat): named channels, publish/subscribe. */
type Listener = (message: unknown, name: string) => void;

export class Channel {
  readonly #listeners = new Set<Listener>();
  constructor(readonly name: string) {}
  get hasSubscribers(): boolean {
    return this.#listeners.size > 0;
  }
  publish(message: unknown): void {
    for (const l of this.#listeners) l(message, this.name);
  }
  subscribe(listener: Listener): void {
    this.#listeners.add(listener);
  }
  unsubscribe(listener: Listener): boolean {
    return this.#listeners.delete(listener);
  }
}

const channels = new Map<string, Channel>();
export function channel(name: string): Channel {
  let c = channels.get(name);
  if (!c) {
    c = new Channel(name);
    channels.set(name, c);
  }
  return c;
}
export const hasSubscribers = (name: string) => channel(name).hasSubscribers;
export const subscribe = (name: string, listener: Listener) => channel(name).subscribe(listener);
export const unsubscribe = (name: string, listener: Listener) =>
  channel(name).unsubscribe(listener);
export default { channel, hasSubscribers, subscribe, unsubscribe, Channel };
