// A hub run elsewhere (the Docker image, a server): a publisher and an editor join it with the
// invitations given as arguments, and the editor calls the publisher's mounts.
//   tsx test/docker-hub.check.ts <publisher blob> <editor blob>
import { ruleSet } from "@statewalker/httpeers-access";
import { createMounts } from "@statewalker/httpeers-core";
import { decodeJoinBlob, startMember } from "@statewalker/httpeers-member";
import { nodePlatform } from "@statewalker/httpeers-member/node";
import { MESH_RULES } from "../../sandbox/src/sandbox/mesh/rules.ts";

const rules = ruleSet(MESH_RULES);
const join = (text: string, mounts = createMounts()) => {
  const b = decodeJoinBlob(text);
  return startMember({
    key: "peers",
    mounts,
    rules,
    config: { relayAddrs: b.relayAddrs, hubPeerId: b.hubPeerId },
    platform: nodePlatform,
    invitationId: b.invitationId,
  });
};
const mounts = createMounts();
mounts.provide("/mcp/edit", async () => Response.json({ ok: true }));
const publisher = await join(process.argv[2], mounts);
const editor = await join(process.argv[3]);
const res = await editor.fetch(new Request(`http://local/peers/${publisher.peerId}/mcp/edit`));
console.log(`publisher ${publisher.hubLink()}, editor ${editor.hubLink()}, editor → publisher: ${res.status}`);
// Ship to the hub: a one-file Worker, deployed by the publisher, opened by the editor.
const b64 = (t: string) => Buffer.from(t).toString("base64");
const put = await publisher.fetch(
  new Request(`http://local/peers/${publisher.hubPeerId}/host/apps/hello`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      files: {
        "/wrangler.json": b64(JSON.stringify({ name: "hello", main: "worker.js", no_bundle: true, compatibility_date: "2026-02-24" })),
        "/worker.js": b64('export default { fetch: () => new Response("hello from the hub") };'),
      },
    }),
  }),
);
const hosted = await editor.fetch(new Request(`http://local/peers/${publisher.hubPeerId}/apps/hello/`));
const text = await hosted.text();
console.log(`deploy: ${put.status}, hosted: ${hosted.status} ${text}`);
await editor.stop();
await publisher.stop();
process.exit(res.status === 200 && text === "hello from the hub" ? 0 : 1);
