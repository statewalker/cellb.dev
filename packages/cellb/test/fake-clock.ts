import type { Clock } from "../src/index.js";

/** Deterministic clock: timers fire only on advance(); async continuations are flushed between timers. */
export class FakeClock implements Clock {
  t = 0;
  #timers = new Map<number, { at: number; fn: () => void }>();
  #id = 0;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.#id;
    this.#timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(h: unknown) {
    this.#timers.delete(h as number);
  }
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      await flush();
      const next = [...this.#timers]
        .filter(([, x]) => x.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.#timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = target;
    await flush();
  }
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
