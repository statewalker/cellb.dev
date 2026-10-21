/**
 * Cron Triggers in celld's dialect (docs/services/cron-triggers.md, = Cloudflare's):
 * five fields — minute, hour, day of month, month, day of week — UTC, one-minute resolution.
 * `*`, values, `a-b`, `a,b`, `/n`; month and weekday names; weekdays 1–7 from SUNDAY;
 * day of month `L`, `L-<n>`, `LW`, `L-<n>W`, `<d>W`; day of week `<dow>L`, `<dow>#<n>`.
 * When both day fields are restricted they form a union. Refused like celld: descending
 * ranges, lists containing `*`, steps wider than the field.
 */
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface Field {
  any: boolean;
  values: Set<number>;
}

function parseSimple(
  text: string,
  min: number,
  max: number,
  names?: string[],
  nameBase = 1,
): Field {
  if (text === "*") return { any: true, values: new Set(range(min, max)) };
  const parts = text.split(",");
  if (parts.length > 1 && parts.includes("*"))
    throw new Error(`cron: a list cannot contain "*": ${text}`);
  const values = new Set<number>();
  const value = (v: string) => {
    const i = names?.indexOf(v.toUpperCase()) ?? -1;
    const n = i >= 0 ? i + nameBase : Number(v);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`cron: value out of range: ${v}`);
    return n;
  };
  for (const part of parts) {
    const [base, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || step > max - min)
      throw new Error(`cron: bad step: ${part}`);
    let lo: number;
    let hi: number;
    if (base === "*") [lo, hi] = [min, max];
    else if (base.includes("-")) {
      const [a, b] = base.split("-");
      [lo, hi] = [value(a), value(b)];
      if (lo > hi) throw new Error(`cron: descending range: ${base}`);
    } else {
      lo = value(base);
      hi = stepText === undefined ? lo : max;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { any: false, values };
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

type DayRule = (y: number, m: number, d: number) => boolean;

function parseDom(text: string): { any: boolean; match: DayRule } {
  if (text === "*") return { any: true, match: () => true };
  const rules: DayRule[] = [];
  for (const part of text.split(",")) {
    const up = part.toUpperCase();
    const last = /^L(?:-(\d+))?(W?)$/.exec(up);
    const weekdayOf = /^(\d+)W$/.exec(up);
    if (last) {
      const m = last;
      const back = Number(m[1] ?? 0);
      const weekday = m[2] === "W";
      rules.push((y, mo, d) => {
        const target = daysInMonth(y, mo) - back;
        return d === (weekday ? nearestWeekday(y, mo, target) : target);
      });
    } else if (weekdayOf) {
      const day = Number(weekdayOf[1]);
      rules.push((y, mo, d) => d === nearestWeekday(y, mo, Math.min(day, daysInMonth(y, mo))));
    } else {
      const f = parseSimple(part, 1, 31);
      rules.push((_y, _m, d) => f.values.has(d));
    }
  }
  return { any: false, match: (y, mo, d) => rules.some((r) => r(y, mo, d)) };
}

function nearestWeekday(y: number, m: number, day: number): number {
  const dow = new Date(Date.UTC(y, m, day)).getUTCDay();
  if (dow === 6) return day > 1 ? day - 1 : day + 2;
  if (dow === 0) return day < daysInMonth(y, m) ? day + 1 : day - 2;
  return day;
}

function parseDow(text: string): { any: boolean; match: DayRule } {
  if (text === "*") return { any: true, match: () => true };
  const rules: DayRule[] = [];
  const dowOf = (v: string) => {
    const i = DAYS.indexOf(v.toUpperCase());
    const n = i >= 0 ? i + 1 : Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 7) throw new Error(`cron: weekday out of range: ${v}`);
    return n - 1; // JS getUTCDay(): 0 = Sunday
  };
  for (const part of text.split(",")) {
    const lastOf = /^(\w+)L$/i.exec(part);
    const nthOf = /^(\w+)#(\d)$/.exec(part);
    if (lastOf && !/^\d+$/.test(part)) {
      const dow = dowOf(lastOf[1]);
      rules.push(
        (y, mo, d) =>
          new Date(Date.UTC(y, mo, d)).getUTCDay() === dow && d + 7 > daysInMonth(y, mo),
      );
    } else if (nthOf) {
      const dow = dowOf(nthOf[1]);
      const nth = Number(nthOf[2]);
      rules.push(
        (y, mo, d) => new Date(Date.UTC(y, mo, d)).getUTCDay() === dow && Math.ceil(d / 7) === nth,
      );
    } else {
      const f = parseSimple(part, 1, 7, DAYS, 1);
      rules.push((y, mo, d) => f.values.has(new Date(Date.UTC(y, mo, d)).getUTCDay() + 1));
    }
  }
  return { any: false, match: (y, mo, d) => rules.some((r) => r(y, mo, d)) };
}

export interface CronSchedule {
  readonly text: string;
  matches(t: number): boolean;
  /** First occurrence strictly after `t` (ms), at a whole minute. */
  next(t: number): number;
}

export function parseCron(text: string): CronSchedule {
  const fields = text.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron: expected 5 fields: ${text}`);
  const minute = parseSimple(fields[0], 0, 59);
  const hour = parseSimple(fields[1], 0, 23);
  const dom = parseDom(fields[2]);
  const month = parseSimple(fields[3], 1, 12, MONTHS, 1);
  const dow = parseDow(fields[4]);
  const dayOk = (y: number, m: number, d: number) =>
    dom.any && dow.any
      ? true
      : dom.any
        ? dow.match(y, m, d)
        : dow.any
          ? dom.match(y, m, d)
          : dom.match(y, m, d) || dow.match(y, m, d);
  const matches = (t: number) => {
    const x = new Date(t);
    return (
      minute.values.has(x.getUTCMinutes()) &&
      hour.values.has(x.getUTCHours()) &&
      month.values.has(x.getUTCMonth() + 1) &&
      dayOk(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())
    );
  };
  return {
    text,
    matches,
    next(t: number) {
      let c = Math.floor(t / 60_000) * 60_000 + 60_000;
      const limit = c + 5 * 366 * 86_400_000;
      while (c < limit) {
        const x = new Date(c);
        if (
          !month.values.has(x.getUTCMonth() + 1) ||
          !dayOk(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())
        ) {
          c = Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate() + 1); // next day, 00:00
          continue;
        }
        if (matches(c)) return c;
        c += 60_000;
      }
      throw new Error(`cron: no occurrence within 5 years: ${text}`);
    },
  };
}

export interface CronClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

/**
 * Runs the Worker's `scheduled(controller, env, ctx)` for each expression, as celld does:
 * one invocation at a time with its `waitUntil()` work drained before the next; a throwing
 * handler retries after 4 s, doubling, until six failures, `controller.noRetry()` or the next
 * occurrence; `scheduledTime` names the occurrence, not the attempt.
 */
export function startCronTriggers(
  expressions: string[],
  handler: (
    controller: unknown,
    ctx: { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void },
  ) => unknown,
  clock: CronClock,
): () => void {
  const schedules = expressions.map(parseCron);
  const timers = new Set<unknown>();
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;
  const at = (t: number, fn: () => void) => {
    const h = clock.setTimeout(
      () => {
        timers.delete(h);
        if (!stopped) fn();
      },
      Math.max(0, t - clock.now()),
    );
    timers.add(h);
  };
  const run = (
    s: CronSchedule,
    scheduledTime: number,
    failures: number,
    nextOccurrence: number,
  ) => {
    chain = chain.then(async () => {
      let retry = true;
      const pending: Promise<unknown>[] = [];
      const controller = {
        cron: s.text,
        scheduledTime,
        type: "scheduled",
        noRetry: () => {
          retry = false;
        },
      };
      try {
        await handler(controller, {
          waitUntil: (p) => pending.push(p),
          passThroughOnException() {},
        });
        await Promise.allSettled(pending);
      } catch {
        await Promise.allSettled(pending);
        const delay = 4_000 * 2 ** failures;
        if (retry && failures + 1 < 6 && clock.now() + delay < nextOccurrence)
          at(clock.now() + delay, () => run(s, scheduledTime, failures + 1, nextOccurrence));
      }
    });
  };
  const arm = (s: CronSchedule, from: number) => {
    const t = s.next(from);
    at(t, () => {
      run(s, t, 0, s.next(t));
      arm(s, t);
    });
  };
  for (const s of schedules) arm(s, clock.now());
  return () => {
    stopped = true;
    for (const h of timers) clock.clearTimeout(h);
    timers.clear();
  };
}
