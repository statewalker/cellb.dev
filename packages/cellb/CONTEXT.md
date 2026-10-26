# cellb

cellb runs Workers and their Durable Objects, as Cloudflare and celld define them, in a browser and
in Node. This glossary fixes what each word means here, where the same word means different things
elsewhere.

Every entry below is _(proposed)_: it was written from the code and the design scenarios, without a
grilling session. The owner confirms or changes each one; the questions that need an answer are
listed at the end.

## Language

### Code and where it runs

**Worker**:
The application code a project deploys: a module whose default export handles requests and whose
other exports are Durable Object classes and entrypoints. _(proposed)_
_Avoid_: script (except in "script name"), app

**Project**:
A Worker together with its wrangler configuration, assets and bindings, as celld deploys it.
_(proposed)_
_Avoid_: site, app

**Script name**:
The `name` of a project's configuration; it is part of every object id the project derives.
_(proposed)_

**Loaded Worker**:
Code a running Worker hands to a Worker Loader binding at run time. _(proposed)_
_Avoid_: dynamic worker, child worker

**Isolate**:
The separate realm one loaded Worker runs in: its own globals, its own environment, and calls to it
copied across a message boundary. Unlike Cloudflare and celld, it is a thread or a Dedicated Worker,
not a V8 isolate, and the project's own Worker does not run in one. _(proposed)_
_Avoid_: sandbox, V8 isolate

**Parent runtime**:
The runtime that created an isolate and answers the isolate's calls to its environment. _(proposed)_
_Avoid_: host (for this role)

**Runtime**:
One running instance of a Worker that hosts that Worker's cells and answers its requests.
_(proposed)_
_Avoid_: engine, cell host

**Host**:
The platform-specific code that builds a runtime and gives it SQLite, files and storage: a Node
process or a browser worker. Used for this one role only. _(proposed)_
_Avoid_: host for an object, a shard, a peer or an isolate's parent

**Platform**:
Where a runtime runs: Node, or a browser. The package's entry points follow platforms. _(proposed)_
_Avoid_: host, environment

### Cells and objects

**Durable Object**:
The programming model: a class, its live instances and the stubs that reach them, as Cloudflare
documents it. Use it when talking about user code. _(proposed)_
_Avoid_: actor, DO (in prose)

**Cell**:
One Durable Object's identity together with its storage: a single SQLite database that is owned,
logged and moved as a unit. Use it when talking about storage, ownership and placement.
_(proposed)_
_Avoid_: object (for the stored unit), actor, scope

**Instance**:
The live JavaScript object of a Durable Object class serving a cell; it is dropped and rebuilt while
the cell's storage stays. _(proposed)_
_Avoid_: object (alone), cell

**Object id**:
The 64-hex-digit identity of a Durable Object, derived from its namespace and a name, or random.
_(proposed)_
_Avoid_: hex id, actor id

**Namespace key**:
The string an object id is derived from: script name and class for Durable Objects, a fleet-wide key
for KV, D1 and Queues. Changing it changes every id. _(proposed)_

**Cell key**:
The name a cell is known by inside cellb: its class and its object id. _(proposed)_
_Avoid_: scope, cell name

**Scope**:
celld's spelling of a cell key, used in bucket keys and in celld's internal tables. Only for celld's
formats. _(proposed)_
_Avoid_: scope for anything else

**Facet**:
A named child database of a cell, with an instance of its own, that lives and moves with its root
cell. A facet is not a cell: it has no ownership of its own and is fenced by its root's epoch.
_(proposed)_
_Avoid_: sub-object, child cell

**Root cell**:
The cell a facet belongs to. _(proposed)_

### Placement

**Node**:
A runtime that is a member of a fleet, under a name recorded in the fleet bucket. _(proposed)_
_Avoid_: node for Node.js (write "Node.js") or for the Node SQLite driver (write "node:sqlite")

**Fleet**:
The nodes, celld and cellb alike, that share one fleet bucket. _(proposed)_
_Avoid_: cluster

**Fleet bucket**:
The object store a fleet keeps its cells, ownership records, node leases, wake index and R2 objects
in, in celld's layout. _(proposed)_
_Avoid_: bucket (alone, when an R2 bucket could be meant), store

**Peer**:
Another node, reached to serve a cell it owns. _(proposed)_
_Avoid_: remote host, remote cell host

**Shard**:
One of a fixed number of partitions of the cells of one browser origin; a shard is held by one
worker at a time. Shards exist only inside a browser origin, never in a fleet. _(proposed)_
_Avoid_: partition, shard for anything on a server

**Shard worker**:
The browser worker that holds a shard and runs its cells. _(proposed)_
_Avoid_: shard host

**Router**:
The single component of a browser origin that forwards requests to the shard worker holding a cell.
_(proposed)_

### Ownership

**Owner**:
The node that may serve and write a cell: the node its ownership record names, at the record's
epoch. Ownership is per cell. _(proposed)_
_Avoid_: holder (alone), master, leader

**Ownership record**:
The record in the fleet bucket that names a cell's owner and epoch. _(proposed)_
_Avoid_: lease (for this record), lock

**Epoch**:
The number in an ownership record, raised every time a node takes the cell; writes carry it, so
writes of an older owner are recognised and ignored. _(proposed)_
_Avoid_: generation, version, term

**Cell lease**:
A runtime's hold on one cell: an epoch, and a signal that fires when the runtime must stop serving
the cell. _(proposed)_
_Avoid_: lock, shard lease

**Node lease**:
A node's time-bound claim to be alive, renewed in the fleet bucket; an owner whose node lease has
expired may be replaced. _(proposed)_
_Avoid_: heartbeat file

**Waker**:
The one node of a fleet, chosen by a lease in the fleet bucket, that fires the alarms of cells no
live node owns.
_(proposed)_
_Avoid_: scheduler, alarm owner

**Shard lock**:
The browser Web Lock a worker holds while it holds a shard. It decides which worker of an origin runs
a shard; it is not ownership in the fleet sense. _(proposed)_
_Avoid_: shard lease, ownership (for this lock)

**Owner lock**:
A Web Lock a shard worker holds only so that the router learns at once when that worker dies.
_(proposed)_

**Self-fencing**:
A node stopping to acknowledge writes once its node lease could have lapsed, before anyone else may
take its cells. _(proposed)_

**Hand-over**:
A cell moving from one owner to the next, the new owner continuing from the durable log.
_(proposed)_
_Avoid_: migration (reserved for data or schema changes), failover

### Durability

**Commit**:
The end of a cell's implicit transaction: all writes of one turn of a handler, applied at once.
_(proposed)_

**Input gate**:
What keeps new events from starting inside a cell while a storage operation is in progress.
_(proposed)_

**Output gate**:
What holds a cell's outgoing messages until the writes they depend on are durable. _(proposed)_

**Durable**:
Stored where the cell can be restored from after its local database is lost. _(proposed)_

**Log**:
The ordered record of a cell's commits kept outside the node, from which the cell is restored.
_(proposed)_
_Avoid_: journal, WAL (those are SQLite's)

**Generation**:
The part of a cell's log written under one epoch; it starts with a snapshot. _(proposed)_
_Avoid_: generation for the alarm tag, a facet restart or a listing version

**Snapshot**:
A log entry that holds every page of a cell's database, so that restore can start from it.
_(proposed)_
_Avoid_: snapshot for a backup image

**Image**:
A complete copy of a cell's database at one moment. _(proposed)_
_Avoid_: dump, snapshot

**Backup**:
An image saved periodically, outside the log; writes made after the last backup can be lost.
_(proposed)_

**RPO**:
How much acknowledged writing can be lost: none with a log, up to one backup interval with backups
alone. _(proposed)_

### Alarms

**Alarm**:
A single point in time at which a cell's `alarm()` handler is due. It is part of the cell's storage
and moves with the cell. _(proposed)_

**Alarm tag**:
The random value an alarm gets each time it is set, so a running handler can tell whether it changed
the alarm itself. _(proposed)_
_Avoid_: generation

**Wake index**:
The listing in the fleet bucket of the alarms of cells, readable without opening any cell.
_(proposed)_

**Wake entry**:
One alarm published in the wake index; it is only a hint, the cell's stored alarm decides.
_(proposed)_

### Life of an instance

**Hibernation**:
An idle cell losing its instance while its storage and its hibernatable WebSockets stay. Unlike on
Cloudflare, a cell without WebSockets hibernates too. Callers do not see it. _(proposed)_
_Avoid_: sleep, eviction

**Eviction**:
A runtime letting go of a cell: its instance, its open database and its cell lease. Callers do not
see it, unless another node owns the cell when it is next called. _(proposed)_
_Avoid_: hibernation, unload

**Broken**:
The state of an instance whose commit, construction or cell lease failed: its callers receive a
"reset" error, and the next call builds a new instance. _(proposed)_
_Avoid_: crashed, dead

## Open questions

Each line is a question for the owner, with the recommended answer in brackets.

- Is a facet a cell? [No: a facet is part of its root cell, with no ownership of its own, fenced by the root's epoch.]
- When a shard lock and an ownership record disagree, who is the owner? [The ownership record; a shard lock only chooses the worker inside one origin, and the two are never combined today.]
- A WebSocket accepted by celld's instance of a cell, then the cell is handed over to a browser node at epoch e+1: who owns the socket? [The node whose instance accepted it; sockets do not move with a cell, writes made from its messages carry that node's epoch e and are refused after the hand-over.]
- A wake entry fires on the waker while another node's cell lease is live: who runs `alarm()`? [The live owner; the waker postpones until that node lease would expire, and the stored alarm, not the wake entry, decides whether anything runs.]
- After renaming a project's `name`, is it the same cell? [No: ids change with the script name, so it is a new cell; the old cells stay under their old keys.]
- Hibernated, evicted, broken: three states or two? [Three; only "broken" is visible to callers, as the "Durable Object reset because …" error.]
- Does any cell or lease own R2 objects in the fleet bucket? [No: they belong to no cell and no lease; concurrent writes to one key are last-writer-wins, as on celld.]
- Keep "lease" for the per-cell port? [Yes for now; it is the only time-bound per-cell hold. The port's comment says "per name (a shard)"; fix the comment, not the name.]
- Rename `SyncSqlDriver.snapshot()` to `image()`? [Yes: it returns an image, and "snapshot" means the first file of a generation.]
- Rename `ObjectHost` to `CellHost` or similar? [No: internal and not exported; the name misleads only in prose.]
- Rename `ProjectHost` to `ProjectPlatform`? [No: "host" here is the one sanctioned meaning (the platform code that builds the runtime).]
- Rename `createShardHost` / `ShardHost` to `createShardWorker` / `ShardWorker`? [Yes: it runs inside a shard worker, and "host" is reserved for the platform.]
- Keep the name "isolate" although it is a realm, not a V8 isolate? [Yes: it matches the Worker Loader API it implements; the glossary records the difference.]
- Should "hibernation" also close the cell's database? [Yes, as a separate, longer idle time: today an idle cell keeps its database open.]
