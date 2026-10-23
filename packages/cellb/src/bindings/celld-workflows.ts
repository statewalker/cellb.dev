// @ts-expect-error — vendored JS (scripts/vendor-celld.mjs)
import { workflowService } from "../../vendor/celld/workflows.js";
import { serialize } from "../v8/serialize.js";

/**
 * Workflows exactly as celld implements them: celld's own instance cell and binding
 * (harness.js, vendored unchanged, Apache-2.0) on a webrun-cells host. An instance is a cell
 * `__Workflow.<script>:<id of "<workflow>/<instance>">` whose state is celld's KV records
 * (`__wf.meta`, `__wf.<generation>.step.<n>.<name>`, V8-serialized) plus its alarm — so a
 * running or sleeping instance moves between celld and webrun-cells with its cell.
 */
export function celldWorkflows(opts: {
  script: string;
  /** workflow name → exported class name (wrangler `workflows`). */
  workflows: Record<string, string>;
  /** The Worker's exports (the workflow classes live there). */
  exports: () => Record<string, unknown>;
  env: () => unknown;
  namespace: () => unknown;
  waitUntil?: (p: Promise<unknown>) => void;
}) {
  // Async-context frame of the step being run (celld: a CPED-backed frame). A plain slot here:
  // it serves celld's check that refuses a step started inside another step's callback.
  let frame: unknown;
  const service = workflowService({
    __cell: {
      get workflows() {
        return opts.workflows;
      },
      get env() {
        return opts.env();
      },
      script: opts.script,
      makeNamespace: () => opts.namespace(),
    },
    __cf: {
      get exports() {
        return opts.exports();
      },
    },
    __sc_encode: serialize,
    __als_get: () => frame,
    __als_set: (f: unknown) => {
      frame = f;
    },
    // Inside the instance's transactionSync: the storage itself is the "scope".
    __alarm_set: (storage: { setAlarmSync(at: number): void }, at: number) =>
      storage.setAlarmSync(at),
    __alarm_delete: (storage: { clearAlarmSync(): void }) => storage.clearAlarmSync(),
    __registerWaitUntil: (p: Promise<unknown>) => {
      if (opts.waitUntil) opts.waitUntil(p);
      else void Promise.resolve(p).catch(() => {});
    },
    __ctxRun: (_frame: unknown, fn: () => unknown) => fn(),
  });
  return {
    className: `__Workflow.${opts.script}`,
    WorkflowCell: service.WorkflowCell,
    binding: (workflowName: string) => service.makeWorkflow(workflowName),
    NonRetryableError: service.NonRetryableError,
  };
}
