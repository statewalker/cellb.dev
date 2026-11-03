# Queues

A producer binding (`env.<BINDING>.send()`, `sendBatch()`) and a consumer (the Worker's `queue()`
handler), as configured under `queues` in the wrangler file. CellB runs celld's own queue code
(vendored unchanged), with the policy part of celld (`celld_logic::queue`, Rust) ported to
TypeScript, so batching, retries, delays and dead-letter queues behave as on celld.

```jsonc
{
  "name": "queues",
  "main": "index.js",
  "compatibility_date": "2026-01-01",
  "queues": {
    "producers": [{ "binding": "JOBS", "queue": "example-jobs" }],
    "consumers": [
      {
        "queue": "example-jobs",
        "max_batch_size": 10,
        "max_batch_timeout": 5,
        "max_retries": 2,
        "dead_letter_queue": "example-jobs-dead-letter"
      },
      { "queue": "example-jobs-dead-letter" }
    ]
  }
}
```

```js
export default {
  async fetch(request, env) {
    const job = {
      path: new URL(request.url).pathname,
      createdAt: new Date().toISOString(),
    };
    await env.JOBS.send(job);
    return Response.json({ queued: job });
  },

  async queue(batch) {
    for (const message of batch.messages) {
      if (batch.queue === "example-jobs-dead-letter") {
        console.log("dead job", message.body);
        message.ack();
        continue;
      }

      if (message.body.path.endsWith("/fail")) {
        console.log("retrying job", message.body, message.attempts);
        message.retry({ delaySeconds: 1 });
        continue;
      }

      console.log("processing job", message.body);
      message.ack();
    }
  },
};
```

This is celld's `queues` example ([conformance/celld-examples/queues](../../conformance/celld-examples/queues/index.js)), copied
unchanged and run by the conformance suite on Node and in Chromium: a request to `…/fail` is retried
twice, then lands in the dead-letter queue.

## A queue is a cell, and its messages move with it

A queue lives in a cell `__Queue:<id>` with celld's schema (`__queue_messages`, `__queue_stats`,
`__queue_meta`, `__queue_transfer_receipts`), so pending messages move between celld and CellB
with the cell. The queue cell's alarm leases a batch; the host then runs the consumer's `queue()`
with celld's batch object and posts the outcome back to the queue cell. `max_concurrency` defaults
to celld's ceiling, 250.

## How it is checked

celld's `queues` example and CellB's `queues-api` and `queues-details` projects, on Node and in
Chromium; `e2e/p11f-celld-one-bucket.test.ts` moves a queue's data celld → CellB → celld.

## What breaks

Errors carry celld's messages: `QUEUE_ERROR: …`.
