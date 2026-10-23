import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { createCellRuntime, DurableObject } from "../src/index.js";

// Facets whose class is the Worker's own (not loaded code): abort() replaces the instance but
// keeps the database; delete() clears it — as celld does.
class Child extends DurableObject {
  memory = 0;
  async bump() {
    this.memory++;
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return { n, memory: this.memory };
  }
}
class Parent extends DurableObject {
  child() {
    return this.ctx.facets.get("c", () => ({ class: (this.ctx as any).exports.Child }));
  }
  async bump() {
    return (this.child() as any).bump();
  }
  abort() {
    this.ctx.facets.abort("c", new Error("stop"));
  }
  async remove() {
    await this.ctx.facets.delete("c");
  }
}

describe("P07j local facets: abort keeps the database, delete clears it", () => {
  it("abort → fresh instance, same storage; delete → empty storage", async () => {
    const rt = createCellRuntime({
      worker: { Parent, Child, default: {} },
      durableObjects: { P: { className: "Parent" } },
      openSql: nodeSqliteOpener(),
    });
    const p = (rt.env.P as any).getByName("p");
    expect(await p.bump()).toEqual({ n: 1, memory: 1 });
    expect(await p.bump()).toEqual({ n: 2, memory: 2 });
    await p.abort();
    expect(await p.bump()).toEqual({ n: 3, memory: 1 });
    await p.remove();
    expect(await p.bump()).toEqual({ n: 1, memory: 1 });
  });
});
