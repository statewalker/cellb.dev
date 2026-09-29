# Server Ownership as in Miniflare 4: Registry Lease with Heartbeat Files

_Working document — 28 September 2026_

## 1. Decision

On the server, apply the lock strategy of Miniflare 4 (wrangler's dev registry, "storage
candidates"), as requested by the user, instead of relying only on OS locks or S3 CAS.

## 2. Miniflare 4's mechanism (workers-sdk, `shared/dev-registry.ts`)

- Registry directory shared by processes (`~/.wrangler/registry/`).
- Each process writes an entry file and **touches its mtime** as a heartbeat
  (storage candidates: every 2 s; stale after 10 s; workers: 10 s / 90 s).
- The **oldest live candidate** owns shared storage.
- Stale entries are deleted by whoever reads them.
- Graceful disposal stops the runtime **before** withdrawing the entry.
- No OS locks, no fencing tokens.

## 3. Implementation: `RegistryLease` (`src/adapters/registry-lease.ts`)

```
{registry}/{shard}/{candidateId}.json   { candidateId, registeredAt, pid }   mtime = heartbeat
```

- `tryAcquire(shard)` registers the process as a candidate (once) and returns a handle only
  if it is the oldest live candidate (by `registeredAt`, then id).
- Heartbeat every `heartbeatMs` (default 2 s) by touching the file; `staleMs` default 10 s.
- The handle re-checks on every heartbeat and aborts `lost` when its entry vanished or its
  registration changed.
- A process whose entry was deleted as stale (it was paused) comes back as a **new, youngest**
  candidate — it cannot silently resume ownership.
- `release()` = stop serving (abort `lost`), then withdraw the entry → immediate hand-over.
- `epoch` = registration time: unique, **not** monotonic → not a fencing token.

## 4. Verified

| Test | Result |
|---|---|
| oldest live candidate owns; younger waits while heartbeats continue (fake clock) | ✅ |
| crashed owner replaced only after its entry is stale; stale file removed | ✅ |
| graceful release hands over at once | ✅ |
| paused owner steps down on resume, comes back youngest | ✅ |
| **no fencing**: during a pause both processes believe they own | ✅ documented |
| real processes: `kill -9` of the owner → successor after ≥ staleMs (300 ms), < 1.5 s | ✅ |
| real processes: graceful release → successor < 250 ms | ✅ |

Mutants killed: youngest owns; entries never go stale; paused owner keeps ownership.

## 5. How it combines with the other leases

| Situation | Election | Safety net |
|---|---|---|
| several processes, one host | `RegistryLease` (Miniflare 4) | exclusive SQLite cell files: a second process cannot open a live owner's cell |
| several hosts, shared bucket | `CasLease` | `FencedManifest` epochs on every durable write |
| browser tabs | Web Locks per shard | worker-held owner lock watched by the ServiceWorker |

The registry gives Miniflare's operational behaviour (observable, heartbeat-based,
graceful hand-over); the exclusive files give what Miniflare does not have: a paused ex-owner
cannot write.

## 6. Open threads

- Registry on a network filesystem: mtime semantics and clock skew between hosts.
- Candidates per shard vs one candidate per process covering all shards (fewer files).
- Routing: the registry can also publish the owner's address (as Miniflare publishes the
  workerd debug port) so other processes forward requests — not implemented yet.
