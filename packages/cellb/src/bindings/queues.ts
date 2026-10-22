import { jsonCodec } from "../core/codec.js";
import { DurableObject } from "../core/durable-object.js";
import type { DurableObjectNamespace } from "../core/namespace.js";
import type { DurableObjectState } from "../core/state.js";

/**
 * Cloudflare Queues as celld implements them: each queue is one cell (a Durable Object of
 * a runtime-supplied class) that owns the durable order, delays, retries and dead-lettering;
 * alarms drive batch delivery to the consumer Worker's `queue(batch, env, ctx)` handler.
 * Semantics follow celld's docs/services/queues.md (at-least-once, no ordering guarantee,
 * no exponential backoff, `max_retries` then `dead_letter_queue` or deletion).
 */
export interface QueueConsumerConfig {
  queue: string;
  max_batch_size?: number;
  max_batch_timeout?: number;
  max_retries?: number;
  /** Batches delivered at the same time (celld: 250 at most). */
  max_concurrency?: number;
  retry_delay?: number;
  dead_letter_queue?: string;
}

export type QueueContentType = "json" | "text" | "bytes" | "v8";

interface Entry {
  body: unknown;
  contentType?: QueueContentType;
  delaySeconds?: number;
}

const LIMITS = {
  messageBytes: 128_000,
  batchMessages: 100,
  batchBytes: 256_000,
  maxDelaySeconds: 86_400,
};

// Errors are plain `Error`s and a text body is converted with String(), as celld does
// (verified by conformance/projects/queues-api against celld 0.6.2).
function encode(e: Entry): Uint8Array {
  const type = e.contentType ?? "json";
  if (type === "text") e.body = String(e.body);
  if (type === "bytes" && !(e.body instanceof ArrayBuffer || ArrayBuffer.isView(e.body)))
    throw new Error("Queue: a bytes message body must be an ArrayBuffer or a view");
  if (type === "json") JSON.stringify(e.body); // throws on non-serializable values, as Cloudflare does
  const bytes = jsonCodec.encode(e.body);
  if (bytes.byteLength > LIMITS.messageBytes)
    throw new Error(`Queue: message larger than ${LIMITS.messageBytes} bytes`);
  const delay = e.delaySeconds ?? 0;
  if (!(delay >= 0 && delay <= LIMITS.maxDelaySeconds))
    throw new Error("Queue: delaySeconds must be within 0..86400");
  return bytes;
}

export interface QueueDispatcher {
  /** Calls the consumer Worker's `queue(batch, env, ctx)` handler. */
  deliver(batch: unknown): Promise<void>;
}

/** Builds the runtime-supplied queue cell class, closed over the consumer configuration. */
export function makeQueueCell(
  consumers: Map<string, QueueConsumerConfig>,
  dispatcher: () => QueueDispatcher | undefined,
  queues: () => DurableObjectNamespace,
  now: () => number = () => Date.now(),
) {
  return class QueueCell extends DurableObject {
    #ready = false;
    #init(): void {
      if (this.#ready) return;
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, body BLOB NOT NULL, content_type TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, visible_at INTEGER NOT NULL, enqueued_at INTEGER NOT NULL)`);
      this.#ready = true;
    }
    get #name(): string {
      return (this.ctx as DurableObjectState).id.name ?? "";
    }
    get #config(): Required<Omit<QueueConsumerConfig, "dead_letter_queue">> & {
      dead_letter_queue?: string;
    } {
      const c = consumers.get(this.#name);
      return {
        queue: this.#name,
        max_batch_size: c?.max_batch_size ?? 10,
        max_concurrency: Math.min(Math.max(c?.max_concurrency ?? 1, 1), 250),
        max_batch_timeout: c?.max_batch_timeout ?? 5,
        max_retries: c?.max_retries ?? 3,
        retry_delay: c?.retry_delay ?? 0,
        dead_letter_queue: c?.dead_letter_queue,
      };
    }

    /** Producer entry point (RPC): commits the messages, then (re)schedules delivery. */
    async __send(entries: Entry[], raw = false): Promise<void> {
      this.#init();
      const t = now();
      let bytes = 0;
      for (const e of entries) {
        const body = raw ? (e.body as Uint8Array) : encode(e);
        bytes += body.byteLength;
        this.ctx.storage.sql.exec(
          "INSERT INTO messages (id, body, content_type, attempts, visible_at, enqueued_at) VALUES (?, ?, ?, ?, ?, ?)",
          crypto.randomUUID().replace(/-/g, ""),
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
          e.contentType ?? "json",
          raw ? Number((e as Entry & { attempts?: number }).attempts ?? 0) : 0,
          t + (e.delaySeconds ?? 0) * 1000,
          t,
        );
      }
      if (!raw && entries.length > 1 && bytes > LIMITS.batchBytes)
        throw new Error(`Queue: batch larger than ${LIMITS.batchBytes} bytes`);
      await this.#schedule();
    }

    async #schedule(): Promise<void> {
      if (!consumers.has(this.#name)) return; // no consumer: messages wait
      const cfg = this.#config;
      const t = now();
      const visible = Number(
        this.ctx.storage.sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM messages WHERE visible_at <= ?", t)
          .one().n,
      );
      const next = this.ctx.storage.sql
        .exec<{ v: number | null }>("SELECT min(visible_at) AS v FROM messages")
        .one().v;
      if (next === null) return;
      const due =
        visible >= cfg.max_batch_size
          ? t
          : Math.max(next, t) + (visible > 0 ? cfg.max_batch_timeout * 1000 : 0);
      const current = await this.ctx.storage.getAlarm();
      if (current === null || due < current) await this.ctx.storage.setAlarm(due);
    }

    /** Delivers one batch to the consumer, then settles every message. */
    async alarm(): Promise<void> {
      this.#init();
      const cfg = this.#config;
      const t = now();
      const rows = this.ctx.storage.sql
        .exec<{ id: string; body: ArrayBuffer; attempts: number; enqueued_at: number }>(
          "SELECT id, body, attempts, enqueued_at FROM messages WHERE visible_at <= ? ORDER BY visible_at, enqueued_at LIMIT ?",
          t,
          cfg.max_batch_size * cfg.max_concurrency,
        )
        .toArray();
      // Leased while in delivery: no other alarm may pick them up (settlement rewrites visible_at).
      for (const r of rows)
        this.ctx.storage.sql.exec(
          "UPDATE messages SET visible_at = ? WHERE id = ?",
          t + 12 * 3_600_000,
          r.id,
        );
      // Up to max_concurrency batches are delivered at once; each is settled on its own.
      const batches: (typeof rows)[] = [];
      for (let i = 0; i < rows.length; i += cfg.max_batch_size)
        batches.push(rows.slice(i, i + cfg.max_batch_size));
      await Promise.all(batches.map((b) => this.#deliverBatch(b, cfg)));
      await this.#schedule();
    }

    async #deliverBatch(
      rows: { id: string; body: ArrayBuffer; attempts: number; enqueued_at: number }[],
      cfg: { queue: string; max_retries: number; retry_delay: number; dead_letter_queue?: string },
    ): Promise<void> {
      {
        const settled = new Map<string, { ack: boolean; delay?: number }>();
        const settle = (id: string, s: { ack: boolean; delay?: number }) => {
          if (!settled.has(id)) settled.set(id, s); // the first call for a message wins
        };
        const messages = rows.map((r) => ({
          id: r.id,
          timestamp: new Date(r.enqueued_at),
          body: jsonCodec.decode(new Uint8Array(r.body)),
          attempts: r.attempts + 1,
          ack: () => settle(r.id, { ack: true }),
          retry: (o: { delaySeconds?: number } = {}) =>
            settle(r.id, { ack: false, delay: o.delaySeconds }),
        }));
        const batch = {
          queue: cfg.queue,
          messages,
          ackAll: () => {
            for (const m of messages) m.ack();
          },
          retryAll: (o: { delaySeconds?: number } = {}) => {
            for (const m of messages) m.retry(o);
          },
        };
        let failed = false;
        try {
          await dispatcher()?.deliver(batch);
        } catch {
          failed = true;
        }
        for (const r of rows) {
          // A returning handler acknowledges every unsettled message; a throwing one retries them.
          const s = settled.get(r.id) ?? { ack: !failed };
          if (s.ack) {
            this.ctx.storage.sql.exec("DELETE FROM messages WHERE id = ?", r.id);
            continue;
          }
          const attempts = r.attempts + 1;
          if (attempts > cfg.max_retries) {
            this.ctx.storage.sql.exec("DELETE FROM messages WHERE id = ?", r.id);
            if (cfg.dead_letter_queue)
              await queues()
                .getByName(cfg.dead_letter_queue)
                .__send([{ body: new Uint8Array(r.body), contentType: "v8", attempts: 0 }], true);
            continue;
          }
          const delay = s.delay ?? cfg.retry_delay;
          this.ctx.storage.sql.exec(
            "UPDATE messages SET attempts = ?, visible_at = ? WHERE id = ?",
            attempts,
            now() + delay * 1000,
            r.id,
          );
        }
      }
    }

    /** Diagnostics (RPC): messages still in the queue. */
    async __size(): Promise<number> {
      this.#init();
      return Number(
        this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM messages").one().n,
      );
    }
  };
}

/** The producer binding (`env.MY_QUEUE.send/sendBatch`). */
export function queueProducer(queues: DurableObjectNamespace, queue: string, defaultDelay = 0) {
  const stub = () => queues.getByName(queue);
  return {
    async send(
      body: unknown,
      options: { contentType?: QueueContentType; delaySeconds?: number } = {},
    ) {
      const e = {
        body,
        contentType: options.contentType,
        delaySeconds: options.delaySeconds ?? defaultDelay,
      };
      encode(e); // validate on the producer side, as Cloudflare does
      await stub().__send([e]);
    },
    async sendBatch(messages: Iterable<Entry>, options: { delaySeconds?: number } = {}) {
      const list = [...messages].map((m) => ({
        ...m,
        delaySeconds: m.delaySeconds ?? options.delaySeconds ?? defaultDelay,
      }));
      if (list.length > LIMITS.batchMessages)
        throw new Error("Queue: at most 100 messages per sendBatch()");
      for (const m of list) encode(m);
      await stub().__send(list);
    },
  };
}
