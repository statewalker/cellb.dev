import { describe, expect, it } from "vitest";
import { startCronTriggers } from "../src/bindings/cron.js";
import { type AlarmEntry, AlarmScheduler } from "../src/core/alarms.js";
import { FakeClock } from "./fake-clock.js";

// Node's setTimeout takes at most 2^31 - 1 ms (about 24.8 days): a longer delay fires after
// 1 ms instead (TimeoutOverflowWarning). An alarm set further ahead than that (celld's
// workflows set 30-day ones) was handed to the timer as is, fired at once, found the stored
// alarm still in the future, was armed again, and woke its object every millisecond.
const MAX_TIMER_MS = 2 ** 31 - 1;
const DAY = 24 * 60 * 60 * 1000;

/** The fake clock, with Node's limit: delays past it fire after 1 ms, and are recorded. */
class NodeLikeClock extends FakeClock {
  readonly delays: number[] = [];
  override setTimeout(fn: () => void, ms: number) {
    this.delays.push(ms);
    return super.setTimeout(fn, ms > MAX_TIMER_MS ? 1 : ms);
  }
}

const entry = { cellKey: "Sleeper/a", className: "Sleeper", idHex: "a" };

describe("P07b alarms further ahead than a timer can wait", () => {
  it("an alarm 30 days ahead fires once, when it is due, and never asks a timer for more than 2^31 - 1 ms", async () => {
    const clock = new NodeLikeClock(1_000_000);
    const fired: number[] = [];
    const alarms = new AlarmScheduler({
      clock,
      fire: async (e: AlarmEntry) => {
        fired.push(clock.now());
        expect(e.at).toBe(at);
      },
    });
    const at = clock.now() + 30 * DAY;
    alarms.set(entry, at);

    await clock.advance(29 * DAY);
    expect(fired).toEqual([]);
    await clock.advance(DAY);
    expect(fired).toEqual([at]);
    await clock.advance(DAY);
    expect(fired).toEqual([at]);

    expect(Math.max(...clock.delays)).toBeLessThanOrEqual(MAX_TIMER_MS);
    // 30 days take two timers: one at the limit, then the rest.
    expect(clock.delays.length).toBeLessThan(5);
    alarms.stop();
  });

  it("a far alarm moved or cleared while it waits does not fire at its old time", async () => {
    const clock = new NodeLikeClock(0);
    const fired: number[] = [];
    const alarms = new AlarmScheduler({ clock, fire: async (e) => void fired.push(e.at) });
    alarms.set(entry, 40 * DAY);
    await clock.advance(26 * DAY); // past the first, capped timer
    alarms.set(entry, 27 * DAY);
    await clock.advance(2 * DAY);
    expect(fired).toEqual([27 * DAY]);
    alarms.set(entry, 60 * DAY);
    await clock.advance(10 * DAY);
    alarms.set(entry, null);
    await clock.advance(60 * DAY);
    expect(fired).toEqual([27 * DAY]);
    alarms.stop();
  });

  it("a cron trigger whose next occurrence is months away runs once, on it, not at once", async () => {
    const clock = new NodeLikeClock(Date.parse("2026-01-02T00:00:00Z"));
    const ran: number[] = [];
    const stop = startCronTriggers(
      ["0 0 1 1 *"], // yearly, 1 January
      (controller) => void ran.push((controller as { scheduledTime: number }).scheduledTime),
      clock,
    );
    await clock.advance(300 * DAY);
    expect(ran).toEqual([]);
    await clock.advance(64 * DAY); // past 2027-01-01
    expect(ran).toEqual([Date.parse("2027-01-01T00:00:00Z")]);
    expect(Math.max(...clock.delays)).toBeLessThanOrEqual(MAX_TIMER_MS);
    stop();
  });

  it("a monthly cron trigger (occurrences 28 to 31 days apart) runs once a month", async () => {
    const clock = new NodeLikeClock(Date.parse("2026-01-15T00:00:00Z"));
    const ran: number[] = [];
    const stop = startCronTriggers(
      ["0 0 1 * *"],
      (controller) => void ran.push((controller as { scheduledTime: number }).scheduledTime),
      clock,
    );
    await clock.advance(Date.parse("2026-04-15T00:00:00Z") - clock.now());
    expect(ran).toEqual(
      ["2026-02-01", "2026-03-01", "2026-04-01"].map((d) => Date.parse(`${d}T00:00:00Z`)),
    );
    stop();
  });
});
