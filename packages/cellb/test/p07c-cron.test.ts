import { describe, expect, it } from "vitest";
import { parseCron, startCronTriggers } from "../src/bindings/cron.js";
import { FakeClock } from "./fake-clock.js";

const at = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString().slice(0, 16);
const occurrences = (expr: string, from: string, n: number) => {
  const s = parseCron(expr);
  const out: string[] = [];
  let t = at(from);
  for (let i = 0; i < n; i++) out.push(iso((t = s.next(t))));
  return out;
};

// Every rule below is a sentence of celld's docs/services/cron-triggers.md.
describe("P07c cron dialect (celld = Cloudflare)", () => {
  it("five fields, UTC, one-minute resolution; *, values, ranges, lists, steps", () => {
    expect(occurrences("* * * * *", "2026-01-01T00:00:30Z", 2)).toEqual([
      "2026-01-01T00:01",
      "2026-01-01T00:02",
    ]);
    expect(occurrences("*/15 9-10 * * *", "2026-01-01T09:20Z", 3)).toEqual([
      "2026-01-01T09:30",
      "2026-01-01T09:45",
      "2026-01-01T10:00",
    ]);
    expect(occurrences("0 6,18 * * *", "2026-01-01T07:00Z", 2)).toEqual([
      "2026-01-01T18:00",
      "2026-01-02T06:00",
    ]);
  });

  it("weekdays are numbered 1 to 7 from Sunday, so 1-5 means Sunday to Thursday; names in any case", () => {
    // 2026-01-02 is a Friday
    expect(occurrences("0 0 * * 1-5", "2026-01-02T00:30Z", 2)).toEqual([
      "2026-01-04T00:00",
      "2026-01-05T00:00",
    ]);
    expect(occurrences("0 0 * * mon", "2026-01-01T00:00Z", 1)).toEqual(["2026-01-05T00:00"]);
    expect(occurrences("0 0 1 jan *", "2026-03-01T00:00Z", 1)).toEqual(["2027-01-01T00:00"]);
  });

  it("both day fields restricted form a union: 0 0 1 * MON = first of month and every Monday", () => {
    expect(occurrences("0 0 1 * MON", "2026-01-26T12:00Z", 3)).toEqual([
      "2026-02-01T00:00",
      "2026-02-02T00:00",
      "2026-02-09T00:00",
    ]);
  });

  it("L, L-n, LW, dW in day of month; dowL and dow#n in day of week", () => {
    expect(occurrences("0 0 L * *", "2026-02-01T00:00Z", 2)).toEqual([
      "2026-02-28T00:00",
      "2026-03-31T00:00",
    ]);
    expect(occurrences("0 0 L-2 * *", "2026-02-01T00:00Z", 1)).toEqual(["2026-02-26T00:00"]);
    expect(occurrences("0 0 LW * *", "2026-05-01T00:00Z", 1)).toEqual(["2026-05-29T00:00"]); // May 31 is a Sunday
    expect(occurrences("0 0 15W * *", "2026-08-01T00:00Z", 1)).toEqual(["2026-08-14T00:00"]); // Aug 15 is a Saturday
    expect(occurrences("0 0 * * 6L", "2026-01-01T00:00Z", 1)).toEqual(["2026-01-30T00:00"]); // last Friday
    expect(occurrences("0 0 * * 2#2", "2026-01-01T00:00Z", 1)).toEqual(["2026-01-12T00:00"]); // 2nd Monday
  });

  it("refuses a descending range, a list containing *, a step wider than its field, and bad arity", () => {
    expect(() => parseCron("0 0 * * SAT-SUN")).toThrow(/descending/);
    expect(() => parseCron("1,* * * * *")).toThrow(/list/);
    expect(() => parseCron("*/60 * * * *")).toThrow(/step/);
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
  });
});

describe("P07c cron execution", () => {
  it("one invocation per occurrence with scheduledTime = the occurrence; serialized; waitUntil drained", async () => {
    const clock = new FakeClock(at("2026-01-01T00:00:30Z"));
    const runs: string[] = [];
    let drained = 0;
    const stop = startCronTriggers(
      ["* * * * *"],
      async (c: any, ctx) => {
        runs.push(`${c.cron} ${iso(c.scheduledTime)}`);
        ctx.waitUntil(Promise.resolve().then(() => drained++));
      },
      clock,
    );
    await clock.advance(120_000); // 00:00:30 → 00:02:30
    stop();
    expect(runs).toEqual(["* * * * * 2026-01-01T00:01", "* * * * * 2026-01-01T00:02"]);
    expect(drained).toBe(2);
  });

  it("a throwing handler retries after 4 s, doubling, with the same scheduledTime; noRetry() stops", async () => {
    const clock = new FakeClock(at("2026-01-01T00:00:00Z"));
    const attempts: [string, number][] = [];
    const stop = startCronTriggers(
      ["0 * * * *"],
      async (c: any) => {
        attempts.push([iso(c.scheduledTime), clock.now() - c.scheduledTime]);
        if (attempts.length === 3) c.noRetry();
        throw new Error("boom");
      },
      clock,
    );
    await clock.advance(3_600_000 + 60_000);
    stop();
    expect(attempts).toEqual([
      ["2026-01-01T01:00", 0],
      ["2026-01-01T01:00", 4_000],
      ["2026-01-01T01:00", 12_000],
    ]);
  });
});
