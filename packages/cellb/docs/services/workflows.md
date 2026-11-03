# Workflows

A `WorkflowEntrypoint` class whose `run(event, step)` is made of durable steps
(`step.do`, `step.sleep`, `step.waitForEvent`), and a binding to create and inspect instances.
CellB runs celld's own workflow engine (vendored unchanged), so an instance's state is celld's and a
running or sleeping instance can move between celld and CellB.

```jsonc
{
  "name": "workflow",
  "main": "index.js",
  "compatibility_date": "2026-08-18",
  "workflows": [
    {
      "binding": "REPORTS",
      "name": "report-builder",
      "class_name": "ReportBuilder"
    }
  ]
}
```

```js
import { WorkflowEntrypoint } from "cloudflare:workers";

export class ReportBuilder extends WorkflowEntrypoint {
  async run(event, step) {
    // A completed step returns its stored result when the Workflow resumes.
    return await step.do("build report", async () => {
      const response = await fetch(event.payload.url);
      if (!response.ok) throw new Error(`source answered ${response.status}`);
      const text = await response.text();
      return { bytes: text.length, lines: text.split("\n").length };
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if (url.pathname === "/create") {
      const instance = await env.REPORTS.create({
        params: { url: url.searchParams.get("url") ?? "https://example.com" },
      });
      return Response.json({ id: instance.id });
    }

    if (url.pathname === "/status" && id) {
      const instance = await env.REPORTS.get(id);
      return Response.json(await instance.status());
    }

    return new Response("Use /create?url=URL or /status?id=ID.", {
      status: 404,
    });
  },
};
```

This is celld's `workflow` example ([conformance/celld-examples/workflow](../../conformance/celld-examples/workflow/index.js)),
copied unchanged and run by the conformance suite on Node and in Chromium.

## An instance is a cell with an alarm

Each instance is a cell `__Workflow.<script>:<id>` holding celld's records (`__wf.meta`, one record
per completed step, V8-serialized) and an alarm that wakes it for its next step. A completed step's
result is stored, so a resumed instance does not run it again.

`e2e/p11f-celld-one-bucket.test.ts` takes one instance across three runtimes through one bucket: its
first step runs on celld, the step after its sleep on CellB, the step after its event on celld
again, and none runs twice.

## How it is checked

celld's `workflow` example and CellB's `workflow-api` project, on Node and in Chromium, and the
celld → CellB → celld trip above.
