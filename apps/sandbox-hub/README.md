# @statewalker/cellb-sandbox-hub

> Private, not published. The hub of a [CellB sandbox](../sandbox) mesh, and a bridge to it.

## What it is

A local Node app, separate from the sandbox, that makes the sandbox reachable from elsewhere
over [HTTPeers](https://github.com/statewalker/httpeers):

- **the hub** (`pnpm start`) holds the mesh's identity (`.sandbox-hub/hub.key`: a new key is a
  new, empty mesh). It holds a reservation on a public relay, by default `relay.httpeers.net`,
  so members anywhere can reach it, and it mints invitations with roles;
- **the host**: a deployer's tab deploys its builds to the hub (Publish → Deploy to the hub). The hub runs
  them on CellB in its own Node process and serves them to the mesh at `/apps/<name>/`;
- **the bridge** (`pnpm bridge <invitation>`) is a mesh member on your computer. It serves a
  published sandbox at `127.0.0.1:8790`: the running app for a browser, and the MCP endpoint
  for a desktop agent.

A sandbox tab **publishes** by joining the mesh: open the link the hub prints, or paste an
invitation in the Ship tab's Publish section. The tab then serves the mesh's members, and the
roles in the hub's invitations decide who may call what (`../sandbox/src/sandbox/mesh/rules.ts`,
read by both sides):

| Role | Reaches |
|---|---|
| `viewer` | `/app/…`: the running app |
| `agent` | + `/mcp/read`: the IDE's tools, read-only |
| `editor` | + `/mcp/edit`: the tools that change the project |
| `admin` | + the hub's admin endpoints, deploys |
| `publisher` | a sandbox tab that serves |
| `deployer` | a publisher that also deploys its builds to the hub. **A deploy runs code on the hub's machine**: give it only to whom you would give a shell there |

Viewers and up also open the apps the hub hosts (`/apps/<name>/…`), and `GET /host/apps` lists
them.

## How to use

```sh
pnpm --filter @statewalker/cellb-sandbox-hub start
```

It prints a link for the sandbox (`SANDBOX_URL`, default `http://localhost:4321/`) with a
single-use `deployer` invitation. It is for your own tab, so don't pass it on. Open it, then open
or start a project. Others who should publish get `invite publisher`, which cannot deploy. To invite others:

```sh
pnpm --filter @statewalker/cellb-sandbox-hub invite editor
```

To check who is in the mesh and how each member reaches the hub, or to remove one:

```sh
pnpm --filter @statewalker/cellb-sandbox-hub members
```

```sh
pnpm --filter @statewalker/cellb-sandbox-hub revoke <peerId>
```

`members` shows each member's link: `direct`, `relay` (others cannot reach it), or `offline`.
`revoke` removes a member. Its tokens stop verifying at once (a published tab refuses it within
about a second, in the test), its reservation on the hub is freed, and it needs a new
invitation to come back.

On the machine of whoever was invited (an agent's, a teammate's):

```sh
pnpm --filter @statewalker/cellb-sandbox-hub bridge '<blob from invite>'
```

The bridge serves `http://127.0.0.1:8790/` (the published sandboxes), `/s/<peer>/app/` (an app)
and `/mcp` (the first sandbox's MCP endpoint: `/mcp/edit` for an editor, `/mcp/read` otherwise).
A desktop agent's MCP configuration is then `{ "type": "http", "url": "http://127.0.0.1:8790/mcp" }`.
Later runs resume the membership without an invitation (`.sandbox-bridge/`).

Settings: `SANDBOX_HUB_DIR`, `SANDBOX_URL`, `SANDBOX_HUB_RELAY_DOC`, `SANDBOX_HUB_GATEWAY_PORT` (the hub);
`SANDBOX_BRIDGE_DIR`, `SANDBOX_BRIDGE_PORT` (the bridge).

## Ship to the hub

When a tab is published, the Publish section has **Deploy to the hub**. It makes the deployable
folder (the same one as Ship → Build) and uploads it to the hub (`PUT /host/apps/<name>`):

- **The hub runs it on CellB**, with `loadProject` from `@statewalker/cellb/node`. It serves it at
  `/apps/<name>/…`. The bridge serves it at `127.0.0.1:8790/h/<name>/`.
- **Releases.** Each deploy is a new release folder, and the last three are kept under
  `.sandbox-hub/apps/<name>/`. The app's Durable Objects keep their data across releases.
- **A release that does not load** is refused (422), and the previous one goes on serving.
- **Data from the preview.** A deploy made with "With the preview's data" (Publish section)
  carries the preview's Durable Object databases in `.cellb-data/`. They seed the app's data on
  its first deploy. With `replaceData`, which that box sets, they replace the app's databases on
  the hub (its R2 objects stay). The databases go to a new data folder; the new release starts on
  it while the old one keeps serving, and the old folder goes only once the new release runs, so
  a deploy that fails changes nothing. They count toward the 64 MB deploy limit.
- **Restarts.** A restarted hub serves its apps again.

The same folder still runs on Cloudflare (`wrangler deploy`) and celld. The hub is just one more
host for it, reached over the mesh.

## The public gateway

To show an app to people who are not members, start the hub with a gateway:

```sh
SANDBOX_HUB_GATEWAY_PORT=8080 pnpm --filter @statewalker/cellb-sandbox-hub start
```

`pnpm gateway '<viewer invitation>'` runs one in a process of its own instead.

- **What it is.** A mesh member with a viewer's role. It listens on every interface and answers
  any Host.
- **What it serves.** Only what was made public:
  - a tab's app while the tab's **Public** box is on, at `/s/<peer>/app/`;
  - apps deployed while that box was on, at `/h/<name>/`.
- **What it never serves.** The MCP tools. `/` lists the public apps.
- **Requests.** Visitors' cookies and `Authorization` headers are not passed to the apps, since
  one origin serves them all.
- **Reaching it from the internet** is up to you: a reverse proxy with TLS (Caddy, nginx) on the
  hub's machine, or a tunnel (`cloudflared`, `tailscale funnel`). It has no TLS, rate limits or
  accounts of its own: put those in the proxy.

### What a deploy can do

A hosted app runs in the hub's own Node process, as CellB runs any Worker on Node. It is not an
isolate, so its code can read the hub's files, `hub.key` included, and that key is the mesh. Only
`deployer` and `admin` may deploy for that reason, and the start link is a `deployer` invitation
for the operator's own tab. Apps also share the process environment (each app's `vars` reach
`process.env`).

An app belongs to the member that first deployed it: another deployer cannot replace or remove
it (403). An admin can, and so can the operator, from the hub's CLI:

```sh
pnpm --filter @statewalker/cellb-sandbox-hub apps
```

```sh
pnpm --filter @statewalker/cellb-sandbox-hub takedown <name>
```

A deploy body over about 90 MB is refused before it is read (413), and a failed upload leaves no
half-written release behind.

**[next]**: run each app in a child process under Node's permission model, with reads limited
to its release and writes to its data folder. CellB's Node SQLite adapter must first stop asking
for extension loading, which the permission model refuses.

## Deploy

The hub needs a machine that stays on: a home server, a VPS, or a laptop while it is in use. It
needs:
- outbound WebSockets to the relay;
- UDP, for the members' WebRTC links;
- a folder that persists. That folder is the mesh: a new key is a new, empty mesh, and every
  member must join again.

Set `SANDBOX_URL` to the sandbox the links should open (`https://cellb.httpeers.net/sandbox/app/`
once the site is published).

```sh
pnpm --filter @statewalker/cellb-sandbox-hub build
```

This writes `dist/sandbox-hub.mjs` and `dist/bridge.mjs`: everything bundled except the native
WebRTC module, `node-datachannel`, and `@statewalker/cellb` (with `esbuild`), which runs the hosted apps. Then pick one of these:

- **Docker**, with host networking:

  ```sh
  docker compose -f apps/sandbox-hub/deploy/compose.yml up -d
  ```

  ```sh
  docker compose -f apps/sandbox-hub/deploy/compose.yml exec hub node /app/sandbox-hub.mjs invite editor
  ```

  The image (`Dockerfile`) is Node 22 slim with `node-datachannel`. It keeps the mesh in the
  `/data` volume and runs as `node`. Where Docker Hub limits pulls, build with
  `--build-arg BASE=mirror.gcr.io/library/node:22-slim`. Behind a TLS-intercepting proxy, add
  `--secret id=ca,src=ca.pem`.
- **systemd**: `deploy/sandbox-hub.service`. The steps are in its header: copy `dist/`, install
  `node-datachannel`, add a system user, then enable the service.
- **By hand**: `node dist/sandbox-hub.mjs start` in a folder where `node-datachannel` and
  `@statewalker/cellb` and `esbuild` are installed.

`test/docker-hub.check.ts <publisher blob> <editor blob>` checks a hub that runs elsewhere. A
publisher and an editor join it, the editor calls the publisher, and the publisher deploys a
one-file Worker that the editor opens. It passed against the image: direct links, and the
membership, identity and hosted apps kept across a restart.

## How it works

- The hub follows httpeers' hub daemon (`apps/hub` there) in a smaller form. Its start order:
  identity, rules, relay document, libp2p node (WebSockets to the relay, circuit relay, WebRTC),
  reservation, `createHub` (state in files), then `servePeer` behind `withAccess`. It has no
  service modules and no admin UI.
- **Members link to the hub directly.** Each member upgrades its relay circuit to WebRTC with
  the hub. The hub then gives it a reservation, which is how members reach each other through
  it. A member whose upgrade fails reaches the hub through the public relay only, and nobody
  can reach it. The sandbox's Publish section says so.
- **Invitations come through a local door.** `invite` and `members` call the running hub over
  `127.0.0.1` with a secret kept in `.sandbox-hub/hub.json` (mode 0600). The door refuses
  browser requests.
- **The sandbox tab is a member without a ServiceWorker edge.** It serves and calls nobody. Its
  three mounts run on capabilities of their own: `/app` fetches the preview's site, `/mcp/read`
  runs the IDE's tools on a read-only token, `/mcp/edit` on a read-write one. Neither token
  reaches the history (`.cellb/`). The tab keeps its identity and its mesh in IndexedDB, so a
  reload resumes the membership.

## Tests

```sh
pnpm --filter @statewalker/cellb-sandbox-hub test
```

This runs a hub on the public relay, a publisher serving `/app` and `/mcp/*`, and a viewer and
an editor that call it with their roles. It takes about 10 s.

```sh
pnpm --filter @statewalker/cellb-sandbox e2e:mesh
```

This runs after `pnpm build`. It starts the hub process, a sandbox tab that publishes from the
hub's link, an editor's bridge (app, MCP reads and writes that show in the tab) and a viewer's
bridge (app yes, MCP 403).
