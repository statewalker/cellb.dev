// The sandbox mesh, for real: this hub (reserved on the public relay, relay.httpeers.net, or on
// RELAY_DOC), a publishing member that serves /app and /mcp/*, and members with other roles
// that call it. Roles come from the invitations; the publisher's withAccess enforces them.
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ruleSet } from "@statewalker/httpeers-access";
import { createMounts } from "@statewalker/httpeers-core";
import { startMember } from "@statewalker/httpeers-member";
import { nodePlatform } from "@statewalker/httpeers-member/node";
import { MESH_RULES } from "../../sandbox/src/sandbox/mesh/rules.ts";
import { startHub } from "../src/hub.ts";

const t0 = Date.now();
const step = (s: string) => console.log(`• ${s} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
const rules = ruleSet(MESH_RULES);
const hubDir = await mkdtemp(join(tmpdir(), "sandbox-hub-"));
const hub = await startHub({
  dataDir: hubDir,
  relayDoc: process.env.RELAY_DOC,
  log: () => {},
});
step(`hub ${hub.peerId.slice(-8)} reserved on ${hub.relayAddrs[0]}`);
const members: { stop(): Promise<void> }[] = [];
try {
  const seen: string[] = [];
  const mounts = createMounts();
  mounts.provide("/app", async (req) => {
    seen.push(new URL(req.url).pathname);
    return new Response("<h1>published app</h1>", { headers: { "content-type": "text/html" } });
  });
  mounts.provide("/mcp/read", async () => Response.json({ tools: "read" }));
  mounts.provide("/mcp/edit", async () => Response.json({ tools: "edit" }));
  const join_ = async (roles: string[], m = createMounts()) => {
    const inv = await hub.invite(roles);
    const member = await startMember({
      key: "peers",
      mounts: m,
      rules,
      config: { relayAddrs: inv.join.relayAddrs, hubPeerId: hub.peerId },
      platform: nodePlatform,
      invitationId: inv.join.invitationId,
      advertisements: () => [],
    });
    members.push(member);
    return member;
  };
  const publisher = await join_(["publisher"], mounts);
  step(`publisher joined (${publisher.hubLink()})`);
  const viewer = await join_(["viewer"]);
  const editor = await join_(["editor"]);
  step(`viewer (${viewer.hubLink()}) and editor (${editor.hubLink()}) joined`);

  const call = async (who: typeof viewer, path: string) => {
    const res = await who.fetch(new Request(`http://local/peers/${publisher.peerId}${path}`));
    return { status: res.status, body: await res.text() };
  };
  const expect = (what: string, got: { status: number; body: string }, status: number) => {
    if (got.status !== status) throw new Error(`${what}: ${got.status} ${got.body.slice(0, 200)}`);
  };
  const app = await call(viewer, "/app/index.html");
  expect("viewer → /app", app, 200);
  if (!app.body.includes("published app")) throw new Error(`app body: ${app.body}`);
  step(`viewer opened the app (the handler saw ${seen.at(-1)})`);
  expect("viewer → /mcp/read", await call(viewer, "/mcp/read"), 403);
  expect("editor → /mcp/read", await call(editor, "/mcp/read"), 200);
  expect("editor → /mcp/edit", await call(editor, "/mcp/edit"), 200);
  step("roles hold: a viewer is refused the MCP endpoints, an editor reaches both");
  // Ship to the hub: a deployer deploys a folder (a no_bundle Worker with a Durable Object); the
  // hub runs it on CellB and serves it at /apps/<name>/ to viewers; a viewer cannot deploy.
  const b64 = (t: string) => Buffer.from(t).toString("base64");
  const folder = {
    "/wrangler.json": b64(
      JSON.stringify({
        name: "counter",
        main: "worker.js",
        no_bundle: true,
        compatibility_date: "2026-02-24",
        durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }],
      }),
    ),
    "/worker.js": b64(`import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async hit() {
    const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return n;
  }
}
export default {
  async fetch(request, env) {
    const n = await env.COUNTER.get(env.COUNTER.idFromName("one")).hit();
    return new Response(\`hosted on the hub: \${new URL(request.url).pathname} #\${n}\`);
  },
};
`),
  };
  const deploy = async (who: typeof viewer, files: Record<string, string>) => {
    const res = await who.fetch(
      new Request(`http://local/peers/${hub.peerId}/host/apps/counter`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files }),
      }),
    );
    return { status: res.status, body: await res.text() };
  };
  const onHub = async (who: typeof viewer, path: string) => {
    const res = await who.fetch(new Request(`http://local/peers/${hub.peerId}${path}`));
    return { status: res.status, body: await res.text() };
  };
  // Deploying runs code on the hub's machine: a publisher may not, a deployer may.
  expect("publisher → deploy", await deploy(publisher, folder), 403);
  const deployer = await join_(["deployer"]);
  const deployer2 = await join_(["deployer"]);
  expect("deployer → deploy", await deploy(deployer, folder), 200);
  // An app belongs to whoever deployed it: another deployer cannot replace it.
  expect("another deployer → replace", await deploy(deployer2, folder), 403);
  const hosted = await onHub(viewer, "/apps/counter/hello");
  expect("viewer → hosted app", hosted, 200);
  if (!hosted.body.includes("hosted on the hub: /hello #1"))
    throw new Error(`hosted: ${hosted.body}`);
  expect("viewer → hosted app again", await onHub(viewer, "/apps/counter/"), 200);
  expect("viewer → list", await onHub(viewer, "/host/apps"), 200);
  expect("viewer → deploy", await deploy(viewer, folder), 403);
  // A new release keeps the Durable Object's data.
  expect("deployer → redeploy", await deploy(deployer, folder), 200);
  const again = await onHub(editor, "/apps/counter/x");
  if (!again.body.includes("#3")) throw new Error(`after the redeploy: ${again.body}`);
  if (hub.apps().length !== 1) throw new Error(`apps: ${JSON.stringify(hub.apps())}`);
  step(
    "Ship to the hub: a deployer deploys, members open it on CellB, a redeploy keeps its data; a viewer, a publisher and another deployer cannot",
  );

  // The preview's data travels with a deploy (Ship with "the preview's data": .cellb-data/): a
  // new app starts from it; an existing one keeps its own unless replaceData.
  const dbOf = async (app: string) => {
    const dir = join(hubDir, "apps", app, "data");
    const name = (await readdir(dir)).find((n) => n.startsWith("Counter") && n.endsWith(".sqlite"));
    if (!name) throw new Error(`no Counter database in ${dir}`);
    return { name, b64: (await readFile(join(dir, name))).toString("base64") };
  };
  const deployAs = async (app: string, extra: Record<string, string>, replaceData = false) => {
    const res = await deployer.fetch(
      new Request(`http://local/peers/${hub.peerId}/host/apps/${app}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files: { ...folder, ...extra }, replaceData }),
      }),
    );
    return { status: res.status, body: await res.text() };
  };
  const db = await dbOf("counter"); // the counter is at 3
  expect(
    "deploy counter2 with counter's data",
    await deployAs("counter2", { [`/.cellb-data/${db.name}`]: db.b64 }),
    200,
  );
  const seeded = await onHub(viewer, "/apps/counter2/");
  if (!seeded.body.includes("#4")) throw new Error(`a seeded app: ${seeded.body}`);
  // A redeploy with data but without replaceData keeps the app's own (at 4).
  expect(
    "redeploy counter2 with data, no replace",
    await deployAs("counter2", { [`/.cellb-data/${db.name}`]: db.b64 }),
    200,
  );
  if (!(await onHub(viewer, "/apps/counter2/")).body.includes("#5"))
    throw new Error("the app's data was replaced");
  // replaceData: back to the deploy's data (3), so the next hit is 4.
  expect(
    "redeploy counter2 replacing its data",
    await deployAs("counter2", { [`/.cellb-data/${db.name}`]: db.b64 }, true),
    200,
  );
  if (!(await onHub(viewer, "/apps/counter2/")).body.includes("#4"))
    throw new Error("replaceData did not replace");
  // A data deploy that does not load leaves the app serving, on its own data (at 4 → 5).
  const broken = { ...folder, "/worker.js": b64("export default {{ broken") };
  const failed = await deployer.fetch(
    new Request(`http://local/peers/${hub.peerId}/host/apps/counter2`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: { ...broken, [`/.cellb-data/${db.name}`]: db.b64 },
        replaceData: true,
      }),
    }),
  );
  expect("a broken data deploy", { status: failed.status, body: await failed.text() }, 422);
  if (!(await onHub(viewer, "/apps/counter2/")).body.includes("#5"))
    throw new Error("a failed data deploy changed the app or its data");
  // Only <cell>.sqlite files right under .cellb-data/.
  expect(
    "a bad .cellb-data path",
    await deployAs("counter2", { "/.cellb-data/x.sqlite/y": db.b64 }),
    400,
  );
  step(
    "the preview's data in a deploy: a new app starts from it, a redeploy keeps its own, replaceData replaces it; a failed one leaves the app and its data as they were",
  );

  const links = hub.members();
  if (links.length !== 5 || !links.every((m) => m.link === "direct"))
    throw new Error(`members' links: ${JSON.stringify(links)}`);
  step("the hub sees five members, each on a direct link");

  // Revoked: out of the member list, its reservation freed, its calls refused once the publisher's
  // revocation cache refreshes (or its link to the publisher drops).
  if (!hub.revoke(viewer.peerId)) throw new Error("revoke: not a member");
  if (hub.members().some((m) => m.peerId === viewer.peerId)) throw new Error("still a member");
  let after = 200;
  for (let i = 0; i < 90 && after === 200; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    after = await call(viewer, "/app/")
      .then((r) => r.status)
      .catch(() => 0);
  }
  if (after === 200) throw new Error("a revoked viewer still opens the app after 90 s");
  step(`the viewer is revoked: the publisher refuses it (${after || "no connection"})`);
  expect("editor → /mcp/edit, after the revoke", await call(editor, "/mcp/edit"), 200);

  // SOAK=<seconds>: the links settle (reservations restored on the direct link) and stay usable.
  const soak = Number(process.env.SOAK ?? 0);
  if (soak > 0) {
    await new Promise((r) => setTimeout(r, soak * 1000));
    expect("viewer → /app, later", await call(viewer, "/app/"), 200);
    expect("editor → /mcp/edit, later", await call(editor, "/mcp/edit"), 200);
    step(`after ${soak} s the publisher still answers both`);
  }
  console.log("mesh: all good");
} finally {
  for (const m of members.reverse()) await m.stop().catch(() => {});
  await hub.stop();
}
process.exit(0);
