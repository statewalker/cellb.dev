// The Python example as a cellb project: a Durable Object whose container is a Wasmer sandbox.
// cellb runs the project unchanged; the node provides the engine (until ctx.container is built
// into cellb, examples reach it with containerFor(ctx, image)).
import { fileURLToPath } from "node:url";
import { loadProject } from "@statewalker/cellb/node";
import { Wasmer } from "@wasmer/sdk/node";
import { afterAll, beforeAll, expect, it } from "vitest";
import { provideContainerEngine, wasmerContainerEngine } from "../src/index.ts";

const dir = fileURLToPath(new URL("../examples/python", import.meta.url));
let wasmer: Wasmer;
let withdraw: () => Promise<void>;
let project: Awaited<ReturnType<typeof loadProject>>;
beforeAll(async () => {
  wasmer = new Wasmer({ cache: { directory: ".wasmer" } });
  withdraw = provideContainerEngine(wasmerContainerEngine(wasmer));
  project = await loadProject(dir);
});
afterAll(async () => {
  await withdraw?.();
  await project?.close();
  await wasmer?.close();
});

const get = async (path: string) =>
  (await project.fetch(new Request(`http://localhost${path}`))).json();

it("cellb reports containers as unsupported, and the example still runs through the engine", async () => {
  expect(project.unsupported).toContain("containers[PyRunner] (cellb runs no containers)");
  const first = await get("/hello?cell=alpha");
  expect(first).toMatchObject({
    cell: "alpha",
    visits: 1,
    fromContainer: { path: "/hello?cell=alpha", cell: "alpha" },
  });
  expect(first.startedMs).toBeGreaterThan(0);
  const again = await get("/again?cell=alpha");
  expect(again).toMatchObject({ visits: 2, startedMs: 0 });
});

it("gives each cell its own container", async () => {
  const beta = await get("/hello?cell=beta");
  expect(beta.fromContainer.cell).toBe("beta");
  expect(beta.visits).toBe(1);
});

it("restarts a destroyed container and keeps the cell's storage", async () => {
  expect(await get("/destroy?cell=alpha")).toMatchObject({ fromContainer: { destroyed: true } });
  const back = await get("/back?cell=alpha");
  expect(back.startedMs).toBeGreaterThan(0);
  expect(back.visits).toBe(4);
});
