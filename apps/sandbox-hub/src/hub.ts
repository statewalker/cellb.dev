// The sandbox mesh's hub. Its identity is the mesh (hub.key: a new key is a new, empty mesh);
// it holds a reservation on a public relay so members anywhere can reach it, answers the WebRTC
// upgrade so members on this machine or network reach it directly (and, through the reservation
// it gives them, each other), and mints invitations with roles from the sandbox's rules.
//
// Built after httpeers' hub daemon (apps/hub: identity → rules → relay → node → reservation →
// createHub → servePeer → local door), smaller: no service modules, no admin UI.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Ed25519PrivateKey, Libp2p } from "@libp2p/interface";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { ruleSet, selfCertifyingKeys, withAccess } from "@statewalker/httpeers-access";
import { mintToken } from "@statewalker/httpeers-access/issuer";
import { ANONYMOUS, createMonotonicClock, lookupPeer } from "@statewalker/httpeers-core";
import { createHub, type Hub, usesTransportIdentity } from "@statewalker/httpeers-hub";
import { fileStorage } from "@statewalker/httpeers-hub/node";
import {
  dialRelay,
  hubRelayService,
  identityStore,
  membershipGater,
  releaseReservation,
  peerIdOf,
  servePeer,
  signerOf,
  superviseRelay,
  waitForCircuitReservation,
} from "@statewalker/httpeers-libp2p";
import { fileBytesStore } from "@statewalker/httpeers-libp2p/node";
import { encodeJoinBlob, type JoinBlob } from "@statewalker/httpeers-member";
import { MESH_RULES } from "../../sandbox/src/sandbox/mesh/rules.ts";

export const PUBLIC_RELAY_DOC = "https://relay.httpeers.net/.well-known/httpeers-relay.json";
const TOKEN_TTL_MS = 15 * 60_000;

export interface HubOptions {
  /** Where the hub keeps its key and state (default ./.sandbox-hub). */
  dataDir: string;
  /** `{ relayAddrs }` (default: the public relay's document). */
  relayDoc?: string;
  /** Or the relay addresses themselves (tests). */
  relayAddrs?: string[];
  log?: (line: string) => void;
}

export interface SandboxHub {
  peerId: string;
  relayAddrs: string[];
  hub: Hub;
  /** A join blob for these roles (the invitation is single-use, `ttlMs` long). */
  invite(
    roles: string[],
    ttlMs?: number,
  ): Promise<{ blob: string; join: JoinBlob; expiresAt: number }>;
  /** Members, with how each reaches the hub now: "direct" (others can reach it), "relay" (they cannot), null (offline). */
  members(): MemberInfo[];
  /** Removes a member: its tokens stop verifying, its reservation is freed, a new invitation is needed. */
  revoke(peerId: string): boolean;
  stop(): Promise<void>;
}

export interface MemberInfo {
  peerId: string;
  roles: string[];
  link: "direct" | "relay" | null;
}

/** How a member reaches the hub, from the hub's open connections (httpeers' apps/hub member-link.ts). */
export function linkOf(node: Pick<Libp2p, "getConnections">, peerId: string): MemberInfo["link"] {
  const open = node
    .getConnections()
    .filter((c) => c.status === "open" && c.remotePeer.toString() === peerId);
  if (open.length === 0) return null;
  return open.some((c) => c.limits == null) ? "direct" : "relay";
}

export async function readRelayDoc(url: string): Promise<string[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`relay: ${url} answered ${res.status}`);
  const doc = (await res.json()) as { relayAddrs?: string[] };
  if (!doc.relayAddrs?.length) throw new Error(`relay: ${url} has no relayAddrs`);
  return doc.relayAddrs;
}

export async function startHub(opts: HubOptions): Promise<SandboxHub> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const dir = opts.dataDir;
  await mkdir(join(dir, "state"), { recursive: true });
  const privateKey = await identityStore({
    backend: fileBytesStore(dir),
    key: "hub.key",
  }).loadOrCreate();
  const peerId = peerIdOf(privateKey);
  log(`hub: identity ${peerId}`);
  const rules = ruleSet(MESH_RULES);
  const relayAddrs = opts.relayAddrs ?? (await readRelayDoc(opts.relayDoc ?? PUBLIC_RELAY_DOC));

  let isMember = (_peerId: string) => false;
  const node: Libp2p = await createLibp2p(privateKey, () => isMember);
  const unwind: (() => unknown)[] = [() => node.stop()];
  const stop = async () => {
    for (const step of unwind.splice(0).reverse()) await Promise.resolve(step()).catch(() => {});
  };
  try {
    let relayAddr: string | undefined;
    const failures: string[] = [];
    for (const addr of relayAddrs) {
      try {
        await dialRelay(node, addr);
        await waitForCircuitReservation(node);
        relayAddr = addr;
        break;
      } catch (err) {
        failures.push(`${addr}: ${(err as Error).message}`);
      }
    }
    if (!relayAddr) throw new Error(`relay: no reservation\n  ${failures.join("\n  ")}`);
    const supervisor = superviseRelay({ node, relayAddr });
    unwind.push(() => supervisor.stop());
    log(`hub: reserved on ${relayAddr}`);

    const signer = signerOf(privateKey);
    const now = createMonotonicClock();
    const hub = await createHub({
      selfPeerId: peerId,
      policies: rules,
      now,
      storage: fileStorage(join(dir, "state", "hub")),
      sweepIntervalMs: 5_000,
      maxTokenTtlMs: TOKEN_TTL_MS,
      mintToken: async (sub, roles, options) =>
        mintToken({
          signer,
          sub,
          roles,
          now,
          ttlMs: Math.min(options?.ttlMs ?? TOKEN_TTL_MS, TOKEN_TTL_MS),
          ...(options?.audience != null ? { audience: options.audience } : {}),
        }),
    });
    unwind.push(() => hub.stop());
    isMember = (p) => hub.isMember(p);

    const peer = await servePeer({
      node,
      mounts: hub.mounts,
      access: withAccess({
        issuer: peerId,
        rules,
        selfPeer: peerId,
        keys: selfCertifyingKeys(),
        provenPeer: (request) => lookupPeer(request) ?? ANONYMOUS,
        bootstrap: usesTransportIdentity(),
        revocation: hub.revocations,
      }),
      serveOnLimitedConnection: true,
    });
    unwind.push(() => peer.stop());

    // A member that reaches the hub through the public relay only cannot be reached by others
    // (no reservation on the hub): said once per member, since a published tab is then unreachable.
    const warned = new Set<string>();
    const watch = setInterval(() => {
      for (const m of hub.members.list() as { peerId: string; roles: string[] }[]) {
        const link = linkOf(node, m.peerId);
        if (link === "relay" && !warned.has(m.peerId)) {
          warned.add(m.peerId);
          log(
            `hub: ${m.peerId} (${m.roles.join(", ")}) reaches the hub through the relay only: other members cannot reach it. A WebRTC upgrade to this hub failed: check UDP and, in Docker, use host networking.`,
          );
        } else if (link === "direct") warned.delete(m.peerId);
      }
    }, 15_000);
    unwind.push(() => clearInterval(watch));

    return {
      peerId,
      relayAddrs: [relayAddr, ...relayAddrs.filter((a) => a !== relayAddr)],
      hub,
      async invite(roles, ttlMs = 24 * 3600_000) {
        const { id, expiresAt } = await hub.invitations.create(roles, ttlMs);
        const join: JoinBlob = { relayAddrs: [relayAddr], hubPeerId: peerId, invitationId: id };
        return { blob: encodeJoinBlob(join), join, expiresAt };
      },
      members: () =>
        hub.members.list().map((m: { peerId: string; roles: string[] }) => ({
          peerId: m.peerId,
          roles: m.roles,
          link: linkOf(node, m.peerId),
        })),
      revoke(member) {
        if (!hub.members.get(member)) return false;
        hub.members.remove(member);
        hub.revocations.revoke(member);
        releaseReservation((node.services as { relay: Parameters<typeof releaseReservation>[0] }).relay, member);
        for (const c of node.getConnections()) if (c.remotePeer.toString() === member) void c.close().catch(() => {});
        return true;
      },

      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

function createLibp2p(privateKey: Ed25519PrivateKey, isMember: () => (p: string) => boolean) {
  return import("libp2p").then(({ createLibp2p }) =>
    createLibp2p({
      privateKey,
      // /p2p-circuit: the reservation on the relay; /webrtc: the upgrade members make to reach
      // the hub directly (and, with the reservation it gives them, to reach each other).
      addresses: { listen: ["/p2p-circuit", "/webrtc"] },
      transports: [webSockets(), circuitRelayTransport(), webRTC()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionGater: membershipGater(isMember),
      services: { identify: identify(), relay: hubRelayService({}) },
    }),
  );
}

/** The hub's local state file: what `sandbox-hub invite` reads to reach the running hub. */
export const HUB_FILE = "hub.json";
export async function writeHubFile(dir: string, info: unknown) {
  await writeFile(join(dir, HUB_FILE), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
}
export async function readHubFile(dir: string) {
  return JSON.parse(await readFile(join(dir, HUB_FILE), "utf8")) as {
    peerId: string;
    door: { port: number; secret: string };
    sandboxUrl: string;
  };
}
