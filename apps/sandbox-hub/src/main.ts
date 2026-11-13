// sandbox-hub: the CellB sandbox mesh's hub, run on your machine.
//
//   pnpm start                       the hub: prints a link that makes a sandbox tab publish
//   pnpm invite editor [agent …]     another invitation, from the running hub
//   pnpm members                     who is in the mesh, and how each reaches the hub
//   pnpm revoke <peerId>             removes a member (a new invitation is needed to come back)
//   pnpm apps | pnpm takedown <name> what the hub hosts; take one down
//
// Settings (environment): SANDBOX_HUB_DIR (./.sandbox-hub), SANDBOX_URL (the sandbox the links
// open, http://localhost:4321/), SANDBOX_HUB_RELAY_DOC (the public relay's document),
// SANDBOX_HUB_GATEWAY_PORT (the public gateway in this process: public apps for non-members).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { MESH_ROLES } from "../../sandbox/src/sandbox/mesh/rules.ts";
import { startBridge } from "./bridge.ts";
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
      if (req.method === "GET" && req.url === "/apps") return send(200, hub.apps());
      const app = req.url?.match(/^\/apps\/([^/]+)$/);
      if (req.method === "DELETE" && app) {
        const done = await hub.removeApp(decodeURIComponent(app[1]));
        return send(done ? 200 : 404, done ? { removed: app[1] } : { error: "no such app" });
      }
      const revoke = req.url?.match(/^\/members\/([^/]+)$/);
      if (req.method === "DELETE" && revoke) {
        const done = hub.revoke(decodeURIComponent(revoke[1]));
        return send(done ? 200 : 404, done ? { revoked: revoke[1] } : { error: "not a member" });
      }
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

  // The public gateway, in this process: a member with a viewer's role, serving what was made public.
  let gateway: Awaited<ReturnType<typeof startBridge>> | undefined;
  const gatewayPort = process.env.SANDBOX_HUB_GATEWAY_PORT;
  if (gatewayPort) {
    const gwDir = join(dir, "gateway");
    const resume = existsSync(join(gwDir, "mesh.json"));
    gateway = await startBridge({
      dir: gwDir,
      port: Number(gatewayPort),
      public: true,
      ...(resume ? {} : { invitation: (await hub.invite(["viewer"], 10 * 60_000)).blob }),
    });
  }

  // The operator's own tab may deploy (deployer: a deploy runs code on this machine). Others get
  // `invite publisher` (serves, cannot deploy) or the roles below.
  const publisher = await hub.invite(["deployer"]);
  console.log(`
The sandbox mesh's hub is up: ${hub.peerId}

Open this link in YOUR sandbox tab to publish it in the mesh (single use, 24 h). It may also deploy
to this hub, which runs the deployed code on this machine: do not hand it to others.
  ${linkOf(publisher.blob)}

Invite people and agents to it:  pnpm invite viewer | agent | editor | publisher${gateway ? `\nPublic gateway (public apps, for anyone): port ${gateway.port}` : ""}
`);
  console.log(`READY ${hub.peerId}`);
  const stop = async () => {
    door.close();
    await gateway?.stop().catch(() => {});
    await hub.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function door(path: string, body?: unknown, method?: string) {
  const info = await readHubFile(dir).catch(() => {
    throw new Error(`no running hub in ${dir} (start it with: pnpm start)`);
  });
  const res = await fetch(`http://127.0.0.1:${info.door.port}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
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
  } else if (cmd === "members") {
    const list = (await door("/members")) as unknown as {
      peerId: string;
      roles: string[];
      link: string | null;
    }[];
    if (!list.length) console.log("No members yet.");
    for (const m of list)
      console.log(
        `${m.peerId}  ${m.roles.join(",").padEnd(10)}  ${m.link ?? "offline"}${m.link === "relay" ? "  (others cannot reach it)" : ""}`,
      );
  } else if (cmd === "apps") {
    const list = (await door("/apps")) as unknown as {
      name: string;
      release: string;
      by: string | null;
      public?: boolean;
    }[];
    if (!list.length) console.log("Nothing hosted yet.");
    for (const a of list)
      console.log(`${a.name}  ${a.release}  ${a.public ? "public" : "members"}  by ${a.by ?? "?"}`);
  } else if (cmd === "takedown") {
    if (!args[0]) throw new Error("takedown <app name> (see: apps)");
    await door(`/apps/${encodeURIComponent(args[0])}`, undefined, "DELETE");
    console.log(`${args[0]} taken down`);
  } else if (cmd === "revoke") {
    if (!args[0]) throw new Error("revoke <peerId> (see: members)");
    await door(`/members/${encodeURIComponent(args[0])}`, undefined, "DELETE");
    console.log(
      `revoked ${args[0]}: its tokens stop verifying; it needs a new invitation to come back`,
    );
  } else throw new Error(`unknown command ${cmd} (start, invite, members, revoke, apps, takedown)`);
} catch (err) {
  console.error(`sandbox-hub: ${(err as Error).message}`);
  process.exit(1);
}
