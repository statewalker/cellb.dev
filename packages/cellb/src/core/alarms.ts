import type { Clock } from "../lease/lease.js";
import type { SyncSqlDriver } from "../ports.js";

export interface AlarmEntry {
  cellKey: string;
  className: string;
  idHex: string;
  at: number;
}

/**
 * Runtime-wide alarm scheduler. Every object's alarm lives in its own `_cf_METADATA`
 * (the truth); this index — one small SQLite database next to the cells — lets a
 * restarted runtime wake objects whose alarms are due without anyone touching them
 * (catch-up after a crash, a closed tab or a frozen page).
 */
export class AlarmScheduler {
  readonly #timers = new Map<string, unknown>();
  readonly #clock: Clock;
  readonly #index?: SyncSqlDriver;
  readonly #fire: (e: AlarmEntry) => Promise<void>;

  constructor(opts: { clock: Clock; index?: SyncSqlDriver; fire: (e: AlarmEntry) => Promise<void> }) {
    this.#clock = opts.clock;
    this.#index = opts.index;
    this.#fire = opts.fire;
    this.#index?.exec(
      "CREATE TABLE IF NOT EXISTS alarms (cell_key TEXT PRIMARY KEY, class_name TEXT, id_hex TEXT, at INTEGER)",
      [],
    );
  }

  /** Re-arms every alarm recorded in the index (due ones fire at once). */
  restore(): void {
    for (const [cellKey, className, idHex, at] of this.#index?.exec("SELECT * FROM alarms", []).rows ?? [])
      this.#arm({ cellKey: String(cellKey), className: String(className), idHex: String(idHex), at: Number(at) });
  }

  set(entry: Omit<AlarmEntry, "at">, at: number | null): void {
    this.#clear(entry.cellKey);
    if (at === null) {
      this.#index?.exec("DELETE FROM alarms WHERE cell_key = ?", [entry.cellKey]);
      return;
    }
    this.#index?.exec("INSERT OR REPLACE INTO alarms VALUES (?, ?, ?, ?)", [entry.cellKey, entry.className, entry.idHex, at]);
    this.#arm({ ...entry, at });
  }

  #arm(e: AlarmEntry): void {
    this.#clear(e.cellKey);
    const delay = Math.max(0, e.at - this.#clock.now());
    this.#timers.set(
      e.cellKey,
      this.#clock.setTimeout(() => {
        this.#timers.delete(e.cellKey);
        void this.#fire(e);
      }, delay),
    );
  }

  #clear(cellKey: string): void {
    const t = this.#timers.get(cellKey);
    if (t !== undefined) this.#clock.clearTimeout(t);
    this.#timers.delete(cellKey);
  }

  stop(): void {
    for (const t of this.#timers.values()) this.#clock.clearTimeout(t);
    this.#timers.clear();
  }
}
