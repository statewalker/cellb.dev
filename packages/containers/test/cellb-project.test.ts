// The Python example as a cellb project: a Durable Object whose ctx.container is a Wasmer sandbox.
// cellb gives objects of a `containers` class ctx.container when loadProject gets an engine; the
// image comes from the project's `cellb.containers` key.
import { fileURLToPath } from "node:url";
import { loadProject } from "@statewalker/cellb/node";
import { Wasmer } from "@wasmer/sdk/node";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type ContainerEngine, wasmerContainerEngine } from "../src/index.ts";

const dir = fileURLToPath(new URL("../examples/python", import.meta.url));
let wasmer: Wasmer;
let engine: ContainerEngine;
let project: Awaited<ReturnType<typeof loadProject>>;
beforeAll(async () => {
  wasmer = new Wasmer({ cache: { directory: ".wasmer" } });
  engine = wasmerContainerEngine(wasmer);
  project = await loadProject(dir, { containers: engine });
});
afterAll(async () => {
  await project?.close(); // destroys the project's containers
  await engine?.close();
  await wasmer?.close();
});

const get = async (path: string) =>
  (await project.fetch(new Request(`http://localhost${path}`))).json();

it("runs the container class: nothing reported, ctx.container answers", async () => {
  expect(project.unsupported).toEqual([]);
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
