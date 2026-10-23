// @ts-expect-error — vendored JS (scripts/vendor-celld.mjs)
import { queueService } from "../../vendor/celld/queues.js";
import { deserialize, serialize } from "../v8/serialize.js";

/**
 * Queues exactly as celld implements them: celld's own queue cell, producer binding and
 * consumer batch (harness.js, vendored unchanged, Apache-2.0) on a webrun-cells host. The
 * queue cell's SQLite layout (`__queue_messages`, `__queue_stats`, …) is therefore celld's, so
 * a queue's pending messages move between celld and webrun-cells with its cell.
 *
 * What the host supplies, as celld's engine does:
 * - `__queue_policy`: celld_logic::queue (Rust) ported below — every deadline and lease rule;
 * - `__queue_dispatch`: runs the consumer's `queue()` with celld's batch object, then posts the
 *   settlement to the queue cell (`/__qSettle`), after the alarm that leased the batch;
 * - limits, consumer configuration, lease duration (celld's defaults).
 */

/** celld_logic::queue and queue_batching defaults (celld 0.6.2). */
export const CELLD_QUEUE_LIMITS = {
  maxMessageBytes: 128_000,
  maxBatchBytes: 256_000,
  maxBatchMessages: 100,
  producerGroupMs: 4,
  maxConcurrency: 250,
  maxDelaySeconds: 86_400,
  retentionMs: 4 * 24 * 60 * 60 * 1000,
  sweepBatchRows: 256,
};
/** admission wait (1 s) + handler budget (300 s) + operation deadline (15 s). */
const LEASE_DURATION_MS = 1_000 + 300_000 + 15_000;

export interface QueueConsumerConfig {
  queue: string;
  max_batch_size?: number;
  max_batch_timeout?: number;
  max_retries?: number;
  dead_letter_queue?: string;
  max_concurrency?: number;
  retry_delay?: number;
}

// ---- celld_logic::queue, ported (logic/queue.rs, celld/queue_policy.rs) ----
type J = Record<string, any>;
const minDefined = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === "number");
  return v.length ? Math.min(...v) : null;
};
const retryAt = (now: number, explicit?: number | null, configured?: number | null) =>
  now + (explicit ?? configured ?? 0) * 1000;
const exhausted = (attempt: number, maxRetries: number) => attempt > maxRetries;

export function queuePolicy(request: J): unknown {
  switch (request.op) {
    case "rearm": {
      const d = minDefined([
        request.batchDeadline,
        request.earliestVisible,
        request.earliestLeaseExpiry,
        request.nextSweep,
      ]);
      return d === null ? null : Math.max(d, request.now);
    }
    case "capacity":
      return request.active < request.maximum;
    case "retries":
      return (request.entries as J[]).map((e) => ({
        at: retryAt(request.now, e.explicitSeconds, e.configuredSeconds),
        exhausted: exhausted(e.attempt, e.maxRetries),
      }));
    case "expiry":
      return (request.entries as J[]).map((e) => {
        const attempt = e.priorFailures + 1;
        const action = e.purgeOnSettle
          ? { kind: "delete-purged" }
          : exhausted(attempt, e.maxRetries)
            ? { kind: "exhausted" }
            : { kind: "retry", at: retryAt(request.now, null, e.configuredSeconds) };
        return { attempt, action };
      });
    case "batch": {
      const leases: J[] = [];
      const deletePurged: number[] = [];
      for (const row of request.rows as J[]) {
        const live = row.leasedUntil != null && row.leasedUntil > request.now;
        if (row.purgeOnSettle) {
          if (!live) deletePurged.push(row.seq);
          continue;
        }
        if (leases.length >= request.maxBatchSize || row.visibleAt > request.now || live) continue;
        leases.push({
          seq: row.seq,
          generation: (BigInt(row.leaseGeneration) + 1n).toString(),
          reclaimed: row.leasedUntil != null,
        });
      }
      return { leases, deletePurged };
    }
    case "settlement": {
      const current = request.current as J[];
      const submitted = request.submitted as J[];
      if (!current.length || current.length !== submitted.length) return false;
      if (current.some((m, i) => current.slice(0, i).some((p) => p.messageId === m.messageId)))
        return false;
      const matched = current.map(() => false);
      for (const s of submitted) {
        const i = current.findIndex(
          (c, j) =>
            !matched[j] &&
            c.messageId === s.messageId &&
            c.seq === s.seq &&
            c.generation === s.generation,
        );
        if (i < 0) return false;
        matched[i] = true;
      }
      return true;
    }
    case "purge": {
      const del: string[] = [];
      const mark: string[] = [];
      for (const row of request.rows as J[])
        (row.leaseIdPresent && row.leasedUntil != null && row.leasedUntil > request.now
          ? mark
          : del
        ).push(row.seq);
      return { delete: del, markForSettle: mark };
    }
    default:
      throw new Error(`unknown Queue policy operation ${JSON.stringify(request.op)}`);
  }
}

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export function celldQueues(opts: {
  /** The namespace of the `__Queue` cells (celld's fleet-wide namespace). */
  namespace: () => { getByName(name: string): { fetch(req: Request): Promise<Response> } };
  consumers: QueueConsumerConfig[];
  /** Runs the Worker's `queue(batch)` handler (celld: the consumer script's entrypoint). */
  runConsumer: (batch: unknown) => Promise<void>;
  /** Wrangler `compatibility_date` decides the default content type (json from 2024-03-18). */
  compatibilityDate?: string;
  /** Background work after the leasing alarm (the consumer runs outside the cell's event). */
  defer?: (work: Promise<unknown>) => void;
}) {
  const consumers: Record<string, J> = {};
  for (const c of opts.consumers)
    consumers[c.queue] = {
      script: "default",
      maxBatchSize: c.max_batch_size ?? 10,
      maxBatchTimeoutMs: (c.max_batch_timeout ?? 5) * 1000,
      maxRetries: c.max_retries ?? 3,
      ...(c.dead_letter_queue ? { deadLetterQueue: c.dead_letter_queue } : {}),
      ...(c.max_concurrency !== undefined ? { maxConcurrency: c.max_concurrency } : {}),
      ...(c.retry_delay !== undefined ? { retryDelaySeconds: c.retry_delay } : {}),
    };
  const cell = {
    queueLimits: CELLD_QUEUE_LIMITS,
    queueConsumers: consumers,
    queueLeaseDurationMs: LEASE_DURATION_MS,
    compat: { queueJsonMessages: (opts.compatibilityDate ?? "2024-03-18") >= "2024-03-18" },
    makeNamespace: () => opts.namespace(),
  };
  // biome-ignore lint/style/useConst: assigned after the service exists
  let service: {
    QueueCell: unknown;
    makeQueue: (q: string, cellName: string, delay: number) => unknown;
    dispatchQueue: (name: string, incoming: J) => Promise<J>;
  };
  const deliver = async (queue: string, batchJson: string) => {
    const batch = JSON.parse(batchJson) as J;
    const incoming = {
      queue,
      messages: (batch.messages as J[]).map((m) => ({
        id: m.id,
        timestamp: m.timestampMs,
        body: unb64(m.bodyBase64),
        contentType: m.contentType,
        attempts: m.attempts,
      })),
      metrics: batch.metrics ?? {},
    };
    const result = await service.dispatchQueue("default", incoming);
    const settlement = {
      leaseId: batch.leaseId,
      leases: batch.leases,
      outcome: result.outcome,
      error: result.error,
      ackAll: result.ackAll,
      retryBatch: result.retryBatch,
      explicitAcks: result.explicitAcks,
      retryMessages: result.retryMessages,
    };
    // celld: a refused settlement leaves the lease to expire (and the messages to retry).
    await opts
      .namespace()
      .getByName(queue)
      .fetch(
        new Request("https://queue.celld.internal/__qSettle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(settlement),
        }),
      );
  };
  service = queueService({
    __cell: cell,
    __queue_policy: (json: string) => JSON.stringify(queuePolicy(JSON.parse(json))),
    // The cell awaits only the hand-off; the consumer runs after its alarm (celld: separate event).
    __queue_dispatch: async (_script: string, queue: string, batchJson: string) => {
      const work = new Promise((r) => setTimeout(r, 0)).then(() => deliver(queue, batchJson));
      if (opts.defer) opts.defer(work);
      else void work.catch((e) => console.error("Queue delivery failed:", e));
    },
    // celld: set the alarm and wait until a durable wake entry covers it. Here the storage
    // itself is the "scope" (DurableObjectStorage._scope); the wake entry is published with the
    // event's commit, which the output gate already waits for.
    __queue_alarm_set_wait: async (storage: { setAlarm(at: number): Promise<void> }, at: number) =>
      storage.setAlarm(at),
    __sc_encode: serialize,
    __sc_decode: deserialize,
    __cellSweepBatch: (
      storage: any,
      select: (n: number) => unknown[],
      reclaim: (row: unknown) => void,
      limit: number,
    ) => {
      let processed = 0;
      storage.transactionSync(() => {
        const rows = select(limit);
        if (rows.length > limit) throw new Error("a cell sweep exceeded its row bound");
        for (const row of rows) {
          reclaim(row);
          processed++;
        }
      });
      return processed;
    },
    __dispatchEntrypointMethodInCurrentEvent: async (
      _name: string,
      _method: string,
      batch: unknown,
    ) => opts.runConsumer(batch),
    btoa: (bytes: Uint8Array) => b64(bytes),
  });
  return {
    QueueCell: service.QueueCell,
    /** The producer binding (celld: `__makeQueue(queue, cellName, deliveryDelay)`). */
    producer: (queue: string, deliveryDelay = 0) => service.makeQueue(queue, queue, deliveryDelay),
  };
}
