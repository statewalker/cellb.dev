# Cron Triggers

`triggers.crons` in the wrangler file runs the Worker's `scheduled(controller, env, ctx)` handler
on a schedule, in celld's dialect, which is Cloudflare's: five fields (minute, hour, day of month,
month, day of week), UTC, one-minute resolution, with `L`, `W` and `#` forms and month and
weekday names.

```jsonc
{
  "name": "cron",
  "main": "index.js",
  "compatibility_date": "2026-01-01",
  "triggers": { "crons": ["* * * * *"] }
}
```

```js
export default {
  async fetch(request, env) {
    return new Response("The cron runs once a minute.\n");
  },
  async scheduled(controller, env, ctx) {
    console.log("cron", controller.scheduledTime);
  },
};
```

This is celld's `cron` example ([conformance/celld-examples/cron](../../conformance/celld-examples/cron/index.js)), copied
unchanged and run by the conformance suite on Node and in Chromium (it waits for a real minute
boundary).

## Each runtime runs the triggers itself

The runtime that loads the project schedules its triggers, as celld does on a node:

- one invocation at a time, with its `waitUntil()` work finished before the next;
- a handler that throws is retried after 4 s, doubling, until it has failed six times,
  `controller.noRetry()` is called, or the next occurrence comes; `scheduledTime` names the
  occurrence, not the attempt;
- the last occurrence that fired is kept in the runtime's SQLite, and after downtime only the latest
  missed occurrence runs.

## What breaks

- **A trigger fires once per runtime that loads the project.** Nothing coordinates triggers between
  runtimes: with `startProjectShards`, every shard worker builds the project and runs its
  triggers, so with four shards a trigger fires four times.
- **In a browser, triggers run only while a page runs the project.** No page means no worker and
  nothing scheduled.
- **`triggers.crons` without a `scheduled()` handler** is reported in `unsupported`, not ignored.
- **An expression celld refuses is refused**: a descending range, a list containing `*`, a step
  wider than its field.
