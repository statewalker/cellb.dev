// Child process: competes for a shard through the Miniflare-style registry and reports.
import { RegistryLease } from "../src/adapters/registry-lease.js";
import { acquire } from "../src/lease/lease.js";

const [dir, name, id] = process.argv.slice(2);
const lease = new RegistryLease({ dir, candidateId: id, heartbeatMs: 50, staleMs: 300 });
process.send!({ type: "registered" });
const h = await acquire(lease, name, { pollMs: 25 });
process.send!({ type: "owner", epoch: h.epoch, at: Date.now() });
h.lost.addEventListener("abort", () => process.send!({ type: "lost" }));
process.on("message", async (m: any) => {
  if (m === "release") {
    await h.release();
    process.send!({ type: "released" });
  }
});
setInterval(() => {}, 1 << 30);
