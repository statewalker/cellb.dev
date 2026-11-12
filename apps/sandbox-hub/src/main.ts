// sandbox-hub: the CellB sandbox mesh's hub, run on your machine.
//
//   pnpm start                       the hub: prints a link that makes a sandbox tab publish
//   pnpm invite editor [agent …]     another invitation, from the running hub
//   pnpm members                     who is in the mesh
//
// Settings (environment): SANDBOX_HUB_DIR (./.sandbox-hub), SANDBOX_URL (the sandbox the links
// open, http://localhost:4321/), SANDBOX_HUB_RELAY_DOC (the public relay's document).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { MESH_ROLES } from "../../sandbox/src/sandbox/mesh/rules.ts";
import { readHubFile, startHub, writeHubFile } from "./hub.ts";

const dir = process.env.SANDBOX_HUB_DIR || ".sandbox-hub";
const sandboxUrl = process.env.SANDBOX_URL || "http://localhost:4321/";
const linkOf = (blob: string) => {
  const u = new URL(sandboxUrl);
  u.searchParams.set("join", blob);
  return u.toString();
};

async function serve() {
  const hub = await startHub({ dataDir: dir, relayDoc: process.env.SANDBOX_HUB_RELAY_DOC });
  // The local door: invitations for the operator's own commands, on loopback, with a secret
  // only this machine's user can read (hub.json, mode 0600).
  const secret = randomBytes(24).toString("base64url");
  const door = createServer(async (req, res) => {
    const given = Buffer.from(String(req.headers["x-sandbox-hub-secret"] ?? ""));
    const want = Buffer.from(secret);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (given.length !== want.length || !timingSafeEqual(given, want))
      return send(401, { error: "no" });
    if (req.headers.origin) return send(403, { error: "no browser requests" });
    try {
      if (req.method === "POST" && req.url === "/invitations") {
        let raw = "";
        for await (const c of req) raw += c;
        const { roles, ttlMs } = JSON.parse(raw || "{}") as { roles?: string[]; ttlMs?: number };
        const inv = await hub.invite(roles?.length ? roles : ["editor"], ttlMs);
        return send(200, { ...inv, link: linkOf(inv.blob) });
      }
      if (req.method === "GET" && req.url === "/members") return send(200, hub.members());
      send(404, { error: "not found" });
    } catch (err) {
      send(400, { error: String((err as Error).message ?? err) });
    }
  });
  await new Promise<void>((r) => door.listen(0, "127.0.0.1", () => r()));
  const port = (door.address() as { port: number }).port;
  await writeHubFile(dir, {
    peerId: hub.peerId,
    relayAddrs: hub.relayAddrs,
    door: { port, secret },
    sandboxUrl,
  });

  const publisher = await hub.invite(["publisher"]);
  console.log(`
The sandbox mesh's hub is up: ${hub.peerId}

Open this link to publish a sandbox tab in the mesh (single use, 24 h):
  ${linkOf(publisher.blob)}

Invite people and agents to it:  pnpm invite viewer | agent | editor
`);
  console.log(`READY ${hub.peerId}`);
  const stop = async () => {
    door.close();
    await hub.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function door(path: string, body?: unknown) {
  const info = await readHubFile(dir).catch(() => {
    throw new Error(`no running hub in ${dir} (start it with: pnpm start)`);
  });
  const res = await fetch(`http://127.0.0.1:${info.door.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-sandbox-hub-secret": info.door.secret, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await res.json();
  if (!res.ok) throw new Error((value as { error?: string }).error ?? `HTTP ${res.status}`);
  return value as Record<string, unknown>;
}

const [cmd = "start", ...args] = process.argv.slice(2);
try {
  if (cmd === "start") await serve();
  else if (cmd === "invite") {
    const roles = args.length ? args : ["editor"];
    for (const r of roles)
      if (!(MESH_ROLES as readonly string[]).includes(r))
        throw new Error(`unknown role ${r} (roles: ${MESH_ROLES.join(", ")})`);
    const inv = await door("/invitations", { roles });
    console.log(
      `Invitation (${roles.join(", ")}), single use, until ${new Date(inv.expiresAt as number).toISOString()}:`,
    );
    console.log(`  link (a sandbox tab):  ${inv.link}`);
    console.log(`  blob (the bridge):     ${inv.blob}`);
  } else if (cmd === "members") console.log(JSON.stringify(await door("/members"), null, 2));
  else throw new Error(`unknown command ${cmd} (start, invite, members)`);
} catch (err) {
  console.error(`sandbox-hub: ${(err as Error).message}`);
  process.exit(1);
}
