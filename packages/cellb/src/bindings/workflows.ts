import { DurableObject } from "../core/durable-object.js";
import type { DurableObjectNamespace } from "../core/namespace.js";

/**
 * Workflows as celld runs them (docs/services/workflows.md): each instance is a cell; `run()`
 * is REPLAYED from the first line whenever the instance makes progress; a finished step
 * returns its stored result; sleeps, event waits and pending retries store their deadline
 * and suspend the instance (alarm-driven); Cloudflare's retry defaults (5 retries, 10 s,
 * exponential, 10 min timeout); events arriving early are buffered.
 */
export interface WorkflowConfig {
  binding: string;
  name: string;
  class_name: string;
}

type Status = "queued" | "running" | "paused" | "errored" | "terminated" | "complete" | "waiting";

interface Meta {
  id: string;
  params: unknown;
  status: Status;
  output?: unknown;
  error?: { name: string; message: string };
  createdAt: number;
}

interface StepRecord {
  done?: boolean;
  result?: unknown;
  attempts?: number;
  retryAt?: number;
  deadline?: number;
}

const SUSPEND = Symbol("workflow-suspend");

/** Durations as celld accepts them: milliseconds as a number, or "<n> <unit>[s]". */
export function parseDuration(d: number | string, what = "duration"): number {
  if (typeof d === "number") return d;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week|month|year)s?\s*$/.exec(d);
  if (!m)
    throw new Error(
      `WORKFLOW_ERROR: invalid duration for ${what}: ${JSON.stringify(d)}; use milliseconds or "<n> <second|minute|hour|day|week|month|year>[s]"`,
    );
  const unit = {
    second: 1e3,
    minute: 6e4,
    hour: 3.6e6,
    day: 8.64e7,
    week: 6.048e8,
    month: 2.592e9,
    year: 3.1536e10,
  }[m[2] as "second"];
  return Number(m[1]) * unit;
}

export function makeWorkflowCell(
  classes: (
    className: string,
  ) =>
    | (new (
        ctx: unknown,
        env: unknown,
      ) => { run(event: unknown, step: unknown): unknown })
    | undefined,
  env: () => unknown,
  now: () => number = () => Date.now(),
) {
  return class WorkflowInstanceCell extends DurableObject {
    #driving: Promise<void> | undefined;
    #again = false;

    async #meta(): Promise<Meta | undefined> {
      return this.ctx.storage.get<Meta>("meta");
    }

    async __create(className: string, id: string, params: unknown): Promise<void> {
      if (await this.#meta()) throw new Error("WORKFLOW_ERROR: instance already exists");
      await this.ctx.storage.put({
        meta: { id, params, status: "queued", createdAt: now() } satisfies Meta,
        className,
      });
      this.#kick();
    }

    async __status() {
      const meta = await this.#meta();
      if (!meta) throw new Error("WORKFLOW_ERROR: instance does not exist");
      const out: Record<string, unknown> = { status: meta.status, rollback: null };
      if (meta.status === "complete") out.output = meta.output ?? null;
      if (meta.error) out.error = meta.error;
      return out;
    }

    /** Removes the instance: its state, steps, events and pending alarm. */
    async __delete(): Promise<void> {
      if (!(await this.#meta())) throw new Error("WORKFLOW_ERROR: instance does not exist");
      await this.ctx.storage.deleteAll();
    }

    async __control(
      op: "pause" | "resume" | "terminate" | "restart" | "event",
      arg?: unknown,
    ): Promise<void> {
      const meta = await this.#meta();
      if (!meta) throw new Error("WORKFLOW_ERROR: instance does not exist");
      if (op === "event") {
        const events = (await this.ctx.storage.get<unknown[]>("events")) ?? [];
        events.push({ ...(arg as object), timestamp: now() });
        await this.ctx.storage.put("events", events);
      } else if (op === "pause") meta.status = "paused";
      else if (op === "resume" && meta.status === "paused") meta.status = "queued";
      else if (op === "terminate") meta.status = "terminated";
      else if (op === "restart") {
        for (const k of (await this.ctx.storage.list({ prefix: "step:" })).keys())
          await this.ctx.storage.delete(k);
        Object.assign(meta, { status: "queued", output: undefined, error: undefined });
      }
      await this.ctx.storage.put("meta", meta);
      this.#kick();
    }

    async alarm(): Promise<void> {
      this.#kick();
      await this.#driving;
    }

    #kick(): void {
      if (this.#driving) {
        this.#again = true;
        return;
      }
      this.#driving = (async () => {
        do {
          this.#again = false;
          await this.#drive();
        } while (this.#again);
      })().finally(() => (this.#driving = undefined));
    }

    /** One replay of run(): stored steps return their results; the first incomplete one suspends. */
    async #drive(): Promise<void> {
      const meta = await this.#meta();
      if (!meta || !["queued", "running", "waiting"].includes(meta.status)) return;
      const Cls = classes((await this.ctx.storage.get<string>("className")) ?? "");
      if (!Cls) throw new Error("Workflow class not found");
      meta.status = "running";
      await this.ctx.storage.put("meta", meta);
      const counts = new Map<string, number>();
      const keyOf = (name: string) => {
        const n = counts.get(name) ?? 0;
        counts.set(name, n + 1);
        return `step:${name}#${n}`;
      };
      let wakeAt = Number.POSITIVE_INFINITY;
      const suspend = (at: number): never => {
        wakeAt = Math.min(wakeAt, at);
        throw SUSPEND;
      };
      const storage = this.ctx.storage;
      const step = {
        async do(name: string, configOrFn: unknown, maybeFn?: () => unknown) {
          const fn = (typeof configOrFn === "function" ? configOrFn : maybeFn) as () => unknown;
          const config = (typeof configOrFn === "function" ? {} : configOrFn) as {
            retries?: {
              limit?: number;
              delay?: number | string;
              backoff?: "constant" | "linear" | "exponential";
            };
            timeout?: number | string;
          };
          const key = keyOf(name);
          const rec = (await storage.get<StepRecord>(key)) ?? {};
          if (rec.done) return rec.result;
          if (rec.retryAt && rec.retryAt > now()) suspend(rec.retryAt);
          const limit = config.retries?.limit ?? 5;
          const delay = parseDuration(
            config.retries?.delay ?? "10 seconds",
            `the retries config delay of step "${name}"`,
          );
          const timeout = parseDuration(
            config.timeout ?? "10 minutes",
            `the timeout of step "${name}"`,
          );
          const attempt = rec.attempts ?? 0;
          try {
            const result = await Promise.race([
              Promise.resolve().then(fn),
              new Promise((_, rej) =>
                setTimeout(() => rej(new Error(`Step "${name}" timed out`)), timeout),
              ),
            ]);
            await storage.put(key, { done: true, result } satisfies StepRecord);
            return result;
          } catch (e) {
            if (e === SUSPEND) throw e;
            if (attempt >= limit) throw e;
            const backoff = config.retries?.backoff ?? "exponential";
            const wait =
              backoff === "constant"
                ? delay
                : backoff === "linear"
                  ? delay * (attempt + 1)
                  : delay * 2 ** attempt;
            const retryAt = now() + wait;
            await storage.put(key, { attempts: attempt + 1, retryAt } satisfies StepRecord);
            return suspend(retryAt);
          }
        },
        async sleep(name: string, duration: number | string) {
          const key = keyOf(name);
          const rec = (await storage.get<StepRecord>(key)) ?? {};
          if (rec.done) return;
          const deadline = rec.deadline ?? now() + parseDuration(duration);
          if (deadline <= now()) return void (await storage.put(key, { done: true }));
          if (!rec.deadline) await storage.put(key, { deadline });
          suspend(deadline);
        },
        async sleepUntil(name: string, when: number | Date) {
          const key = keyOf(name);
          const rec = (await storage.get<StepRecord>(key)) ?? {};
          if (rec.done) return;
          const deadline = when instanceof Date ? when.getTime() : when;
          if (deadline <= now()) return void (await storage.put(key, { done: true }));
          suspend(deadline);
        },
        async waitForEvent(name: string, options: { type: string; timeout?: number | string }) {
          const key = keyOf(name);
          const rec = (await storage.get<StepRecord>(key)) ?? {};
          if (rec.done) return rec.result;
          const events =
            (await storage.get<{ type: string; payload: unknown; timestamp: number }[]>(
              "events",
            )) ?? [];
          const i = events.findIndex((e) => e.type === options.type);
          if (i >= 0) {
            const [event] = events.splice(i, 1);
            await storage.put({
              events,
              [key]: { done: true, result: event } satisfies StepRecord,
            });
            return event;
          }
          const deadline = rec.deadline ?? now() + parseDuration(options.timeout ?? "24 hours");
          if (deadline <= now()) throw new Error(`waitForEvent "${name}" timed out`);
          if (!rec.deadline) await storage.put(key, { deadline });
          return suspend(deadline);
        },
      };
      const instance = new Cls({ waitUntil() {}, passThroughOnException() {} }, env());
      const event = {
        payload: meta.params,
        timestamp: new Date(meta.createdAt),
        instanceId: meta.id,
      };
      try {
        const output = await instance.run(event, step);
        Object.assign(meta, { status: "complete", output });
        await this.ctx.storage.deleteAlarm();
      } catch (e) {
        if (e === SUSPEND) {
          meta.status = "waiting";
          if (Number.isFinite(wakeAt)) await this.ctx.storage.setAlarm(wakeAt);
        } else
          Object.assign(meta, {
            status: "errored",
            error: {
              name: (e as Error)?.name ?? "Error",
              message: String((e as Error)?.message ?? e),
            },
          });
      }
      const current = await this.#meta();
      if (current && current.status !== "running") return; // paused/terminated meanwhile
      await this.ctx.storage.put("meta", meta);
    }
  };
}

/** The Workflow binding (`env.MY_WORKFLOW.create/createBatch/get`). */
export function workflowBinding(cells: DurableObjectNamespace, config: WorkflowConfig) {
  const cell = (id: string) => cells.getByName(`${config.name}/${id}`);
  const handle = (id: string) => ({
    id,
    status: () => cell(id).__status(),
    pause: () => cell(id).__control("pause"),
    resume: () => cell(id).__control("resume"),
    terminate: () => cell(id).__control("terminate"),
    restart: () => cell(id).__control("restart"),
    sendEvent: (e: { type: string; payload?: unknown }) => cell(id).__control("event", e),
    delete: () => cell(id).__delete(),
  });
  return {
    async create(options: { id?: string; params?: unknown } = {}) {
      const id = options.id ?? crypto.randomUUID();
      await cell(id).__create(config.class_name, id, options.params ?? {});
      return handle(id);
    },
    async createBatch(list: { id?: string; params?: unknown }[]) {
      const out = [];
      for (const o of list) out.push(await this.create(o));
      return out;
    },
    /** Deletes several instances; reports each deletion and each failure (celld's shape). */
    async deleteBatch(ids: string[]) {
      const deleted: { id: string }[] = [];
      const errors: { id: string; error: string }[] = [];
      for (const id of ids)
        await cell(id)
          .__delete()
          .then(
            () => deleted.push({ id }),
            (e: Error) => errors.push({ id, error: e.message }),
          );
      return { deleted, errors };
    },
    async get(id: string) {
      await cell(id).__status(); // throws "WORKFLOW_ERROR: instance does not exist"
      return handle(id);
    },
  };
}
