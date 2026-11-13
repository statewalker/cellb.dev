// sandbox-hub bridge: a published sandbox, at localhost. A Node mesh member (with the role its
// invitation gave it) that serves, on 127.0.0.1 only:
//
//   /                       the published sandboxes in the mesh
//   /s/<peer>/app/…         a sandbox's running app, for a browser          (viewer and up)
//   /s/<peer>/mcp           its MCP endpoint, for a desktop agent: /mcp/edit for an editor,
//                           /mcp/read otherwise                              (agent and up)
//   /h/<name>/…             an app the hub hosts (deployed from a tab: Publish → Deploy to the hub)
//   /mcp                    the same, for the first published sandbox (an agent's config:
//                           { "type": "http", "url": "http://127.0.0.1:8790/mcp" })
//
//   pnpm bridge <invitation blob or link>     the first time
//   pnpm bridge                               later: the membership resumes
//
// Settings: SANDBOX_BRIDGE_DIR (./.sandbox-bridge), SANDBOX_BRIDGE_PORT (8790).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { ruleSet } from "@statewalker/httpeers-access";
import { createMounts } from "@statewalker/httpeers-core";
import { identityStore } from "@statewalker/httpeers-libp2p";
import { fileBytesStore } from "@statewalker/httpeers-libp2p/node";
import { decodeJoinBlob, type MemberHandle, startMember } from "@statewalker/httpeers-member";
import { nodePlatform } from "@statewalker/httpeers-member/node";
import { MESH_RULES, SANDBOX_ADVERT } from "../../sandbox/src/sandbox/mesh/rules.ts";

export interface Bridge {
  member: MemberHandle;
  port: number;
  url: string;
  stop(): Promise<void>;
}

export async function startBridge(opts: {
  dir: string;
  port?: number;
  invitation?: string;
  log?: (l: string) => void;
}): Promise<Bridge> {
  const log = opts.log ?? ((l: string) => console.log(l));
  await mkdir(opts.dir, { recursive: true });
  const meshFile = join(opts.dir, "mesh.json");
  let invitationId: string | undefined;
  let config: { relayAddrs: string[]; hubPeerId: string };
  if (opts.invitation) {
    const text = opts.invitation.includes("join=")
      ? (new URL(opts.invitation).searchParams.get("join") ?? opts.invitation)
      : opts.invitation;
    const blob = decodeJoinBlob(text);
    config = { relayAddrs: blob.relayAddrs, hubPeerId: blob.hubPeerId };
    invitationId = blob.invitationId;
  } else {
    config = JSON.parse(
      await readFile(meshFile, "utf8").catch(() => {
        throw new Error("no membership yet: pass an invitation (sandbox-hub invite agent)");
      }),
    );
  }
  const privateKey = await identityStore({
    backend: fileBytesStore(opts.dir),
    key: "member.key",
  }).loadOrCreate();
  const member = await startMember({
    key: "peers",
    mounts: createMounts(),
    rules: ruleSet(MESH_RULES),
    config,
    platform: nodePlatform,
    privateKey,
    ...(invitationId ? { invitationId } : {}),
  });
  await writeFile(meshFile, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  log(
    `bridge: member ${member.peerId} of ${config.hubPeerId} (${member.joinedBy}, ${member.hubLink()} link)`,
  );

  const sandboxes = () =>
    (member.meshView()?.advertisements ?? []).filter((a) => a.id === SANDBOX_ADVERT);
  const toMesh = async (req: IncomingMessage, peer: string, path: string) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (v !== undefined && !["host", "connection", "origin", "referer"].includes(k))
        headers.set(k, String(v));
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks);
    return member.fetch(
      new Request(`http://local/peers/${peer}${path}`, { method: req.method, headers, body }),
    );
  };
  const mcp = async (req: IncomingMessage, peer: string) => {
    const edit = await toMesh(req, peer, "/mcp/edit");
    return edit.status === 403 ? toMesh(req, peer, "/mcp/read") : edit;
  };
  let port = opts.port ?? 8790;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const reply = async (res: ServerResponse, r: Response) => {
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => {
      if (k !== "content-encoding" && k !== "content-length" && k !== "transfer-encoding")
        headers[k] = v;
    });
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
  };
  const server = createServer(async (req, res) => {
    try {
      // Loopback only, and not a DNS-rebound page: the Host must be this server's own.
      if (!allowedHosts().has(String(req.headers.host))) {
        res.writeHead(421).end("misdirected");
        return;
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const m = url.pathname.match(/^\/s\/([^/]+)(\/.*)?$/);
      const hosted = url.pathname.match(/^\/h\/([^/]+)(\/.*)?$/);
      if (hosted) {
        if (!hosted[2]) {
          res.writeHead(302, { location: `/h/${hosted[1]}/` }).end();
          return;
        }
        await reply(res, await toMesh(req, config.hubPeerId, `/apps/${hosted[1]}${hosted[2]}${url.search}`));
        return;
      }
      if (url.pathname === "/") {
        const list = sandboxes();
        const apps = (await member
          .fetch(new Request(`http://local/peers/${config.hubPeerId}/host/apps`))
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => [])) as { name: string; release: string }[];
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Published sandboxes</title><h1>Published sandboxes</h1><ul>${list
            .map(
              (a) =>
                `<li><a href="/s/${a.peerId}/app/">${a.title.replace(/[<&]/g, "")}</a> <code>${a.peerId}</code> — MCP: <code>/s/${a.peerId}/mcp</code></li>`,
            )
            .join("")}</ul>${list.length ? "" : "<p>None yet.</p>"}<h2>Hosted by the hub</h2><ul>${apps
            .map((a) => `<li><a href="/h/${a.name}/">${a.name}</a> <code>${a.release}</code></li>`)
            .join("")}</ul>${apps.length ? "" : "<p>None yet.</p>"}`,
        );
      } else if (url.pathname === "/mcp") {
        const first = sandboxes()[0];
        if (!first)
          await reply(
            res,
            Response.json({ error: "no published sandbox in the mesh" }, { status: 503 }),
          );
        else await reply(res, await mcp(req, first.peerId));
      } else if (m && (m[2] === "/mcp" || m[2] === "/mcp/")) {
        await reply(res, await mcp(req, m[1]));
      } else if (m && (m[2] ?? "/").startsWith("/app")) {
        if (!m[2] || m[2] === "/app") {
          res.writeHead(302, { location: `/s/${m[1]}/app/` }).end();
          return;
        }
        await reply(res, await toMesh(req, m[1], `${m[2]}${url.search}`));
      } else {
        res.writeHead(404).end("not found");
      }
    } catch (err) {
      res
        .writeHead(502, { "content-type": "text/plain" })
        .end(String((err as Error).message ?? err));
    }
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/`;
  log(`bridge: ${url} (sandboxes: ${url}, MCP: ${url}mcp)`);
  return {
    member,
    port,
    url,
    async stop() {
      server.close();
      await member.stop();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const bridge = await startBridge({
      dir: process.env.SANDBOX_BRIDGE_DIR || ".sandbox-bridge",
      port: Number(process.env.SANDBOX_BRIDGE_PORT || 8790),
      invitation: process.argv[2],
    });
    const stop = async () => {
      await bridge.stop();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (err) {
    console.error(`sandbox-hub bridge: ${(err as Error).message}`);
    process.exit(1);
  }
}
