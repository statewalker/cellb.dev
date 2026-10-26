# cellb

cellb runs Workers and their Durable Objects, as Cloudflare and celld define them, in a browser and
in Node. This glossary fixes what each word means here, where the same word means different things
elsewhere.

## Language

### Code and where it runs

**Worker**:
The application code a project deploys: a module whose default export handles requests and whose
other exports are Durable Object classes and entrypoints.
_Avoid_: script (except in "script name"), app

**Project**:
A Worker together with its wrangler configuration, assets and bindings, as celld deploys it.
_Avoid_: site, app

**Script name**:
The `name` of a project's configuration; it is part of every object id the project derives, so a
project renamed is a new set of cells and the old ones stay under their old keys.

**Loaded Worker**:
Code a running Worker hands to a Worker Loader binding at run time.
_Avoid_: dynamic worker, child worker

**Isolate**:
The separate realm one loaded Worker runs in: its own globals, its own environment, and calls to it
copied across a message boundary. Unlike Cloudflare and celld, it is a thread or a Dedicated Worker,
not a V8 isolate, and the project's own Worker does not run in one.
_Avoid_: sandbox, V8 isolate

**Parent runtime**:
The runtime that created an isolate and answers the isolate's calls to its environment.
_Avoid_: host (for this role)

**Runtime**:
One running instance of a Worker that hosts that Worker's cells and answers its requests.
_Avoid_: engine, cell host

**Host**:
The platform-specific code that builds a runtime and gives it SQLite, files and storage: a Node
process or a browser worker. Used for this one role only.
_Avoid_: host for an object, a shard, a peer or an isolate's parent

**Platform**:
Where a runtime runs: Node, or a browser. The package's entry points follow platforms.
_Avoid_: host, environment

### Cells and objects

**Durable Object**:
The programming model: a class, its live instances and the stubs that reach them, as Cloudflare
documents it. Use it when talking about user code.
_Avoid_: actor, DO (in prose)

**Cell**:
One Durable Object's identity together with its storage: a single SQLite database that is owned,
logged and moved as a unit. Use it when talking about storage, ownership and placement.
_Avoid_: object (for the stored unit), actor, scope

**Instance**:
The live JavaScript object of a Durable Object class serving a cell; it is dropped and rebuilt while
the cell's storage stays.
_Avoid_: object (alone), cell

**Object id**:
The 64-hex-digit identity of a Durable Object, derived from its namespace and a name, or random.
_Avoid_: hex id, actor id

**Namespace key**:
The string an object id is derived from: script name and class for Durable Objects, a fleet-wide key
for KV, D1 and Queues. Changing it changes every id.

**Cell key**:
The name a cell is known by inside cellb: its class and its object id.
_Avoid_: scope, cell name

**Scope**:
celld's spelling of a cell key, used in bucket keys and in celld's internal tables. Only for celld's
formats.
_Avoid_: scope for anything else

**Facet**:
A named child database of a cell, with an instance of its own, that lives and moves with its root
cell. A facet is not a cell: it has no ownership of its own and is fenced by its root's epoch.
_Avoid_: sub-object, child cell

**Root cell**:
The cell a facet belongs to.

### Placement

**Node**:
A runtime that is a member of a fleet, under a name recorded in the fleet bucket.
_Avoid_: node for Node.js (write "Node.js") or for the Node SQLite driver (write "node:sqlite")

**Fleet**:
The nodes, celld and cellb alike, that share one fleet bucket.
_Avoid_: cluster

**Fleet bucket**:
The object store a fleet keeps its cells, ownership records, node leases, wake index and R2 objects
in, in celld's layout.
_Avoid_: bucket (alone, when an R2 bucket could be meant), store

**R2 object**:
An object of an R2 binding, kept directly in the fleet bucket. It belongs to no cell and no lease;
concurrent writes to one key are last-writer-wins.

**Peer**:
Another node, reached to serve a cell it owns.
_Avoid_: remote host, remote cell host

**Shard**:
One of a fixed number of partitions of the cells of one browser origin; a shard is held by one
worker at a time. Shards exist only inside a browser origin, never in a fleet.
_Avoid_: partition, shard for anything on a server

**Shard worker**:
The browser worker that holds a shard and runs its cells.
_Avoid_: shard host

**Router**:
The single component of a browser origin that forwards requests to the shard worker holding a cell.

### Ownership

**Owner**:
The node that may serve and write a cell: the node its ownership record names, at the record's
epoch. Ownership is per cell; a shard lock never makes a worker an owner, and when the two disagree
the ownership record wins.
_Avoid_: holder (alone), master, leader

**Ownership record**:
The record in the fleet bucket that names a cell's owner and epoch.
_Avoid_: lease (for this record), lock

**Epoch**:
The number in an ownership record, raised every time a node takes the cell; writes carry it, so
writes of an older owner are recognised and ignored.
_Avoid_: generation, version, term

**Cell lease**:
A runtime's hold on one cell: an epoch, and a signal that fires when the runtime must stop serving
the cell.
_Avoid_: lock, shard lease

**Node lease**:
A node's time-bound claim to be alive, renewed in the fleet bucket; an owner whose node lease has
expired may be replaced.
_Avoid_: heartbeat file

**Waker**:
The one node of a fleet, chosen by a lease in the fleet bucket, that fires the alarms of cells no
live node owns. A live owner fires its own cells' alarms.
_Avoid_: scheduler, alarm owner

**Shard lock**:
The browser Web Lock a worker holds while it holds a shard. It decides which worker of an origin runs
a shard; it is not ownership in the fleet sense.
_Avoid_: shard lease, ownership (for this lock)

**Owner lock**:
A Web Lock a shard worker holds only so that the router learns at once when that worker dies.

**Self-fencing**:
A node stopping to acknowledge writes once its node lease could have lapsed, before anyone else may
take its cells.

**Hand-over**:
A cell moving from one owner to the next, the new owner continuing from the durable log.
WebSockets do not move with it: a socket stays with the node whose instance accepted it, and that
node's writes are no longer accepted once the cell has a newer epoch.
_Avoid_: migration (reserved for data or schema changes), failover

### Durability

**Commit**:
The end of a cell's implicit transaction: all writes of one turn of a handler, applied at once.

**Input gate**:
What keeps new events from starting inside a cell while a storage operation is in progress.

**Output gate**:
What holds a cell's outgoing messages until the writes they depend on are durable.

**Durable**:
Stored where the cell can be restored from after its local database is lost.

**Log**:
The ordered record of a cell's commits kept outside the node, from which the cell is restored.
_Avoid_: journal, WAL (those are SQLite's)

**Generation**:
The part of a cell's log written under one epoch; it starts with a snapshot.
_Avoid_: generation for the alarm tag, a facet restart or a listing version

**Snapshot**:
A log entry that holds every page of a cell's database, so that restore can start from it.
_Avoid_: snapshot for a backup image

**Image**:
A complete copy of a cell's database at one moment.
_Avoid_: dump, snapshot

**Backup**:
An image saved periodically, outside the log; writes made after the last backup can be lost.

**RPO**:
How much acknowledged writing can be lost: none with a log, up to one backup interval with backups
alone.

### Alarms

**Alarm**:
A single point in time at which a cell's `alarm()` handler is due. It is part of the cell's storage
and moves with the cell.

**Alarm tag**:
The random value an alarm gets each time it is set, so a running handler can tell whether it changed
the alarm itself.
_Avoid_: generation

**Wake index**:
The listing in the fleet bucket of the alarms of cells, readable without opening any cell.

**Wake entry**:
One alarm published in the wake index; it is only a hint, the cell's stored alarm decides.

### Life of an instance

**Hibernation**:
An idle cell losing its instance while its storage and its hibernatable WebSockets stay. Unlike on
Cloudflare, a cell without WebSockets hibernates too. Callers do not see it.
_Avoid_: sleep, eviction

**Eviction**:
A runtime letting go of a cell: its instance, its open database and its cell lease. Callers do not
see it, unless another node owns the cell when it is next called.
_Avoid_: hibernation, unload

**Broken**:
The state of an instance whose commit, construction or cell lease failed: its callers receive a
"reset" error, and the next call builds a new instance. Hibernated, evicted and broken are three
distinct states, and only this one is visible to callers.
_Avoid_: crashed, dead
