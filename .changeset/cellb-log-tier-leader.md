---
"@statewalker/cellb": minor
---

cellb leads and recovers sessions of celld's log tier, as a celld node does (#209). `cellb serve` (`startFleetNode`) leads unless `--durability bucket` (`CELLD_DURABILITY`): its commits are acknowledged once its followers (celld or cellb nodes) hold their LTX segments, or once the bucket does, whichever is first, with uploads kept in TXID order. Every node recovers the session of a dead leader, celld's or cellb's (claim, seal and tail the followers, upload what the bucket lacks, seal), unless it left celld node bundles. The node record is written by compare-and-swap and carries the session (`log`); a node that published one keeps its record, expired and sealed, when it closes. New exports from `@statewalker/cellb/node`: `createLogLeader`, `createLogRecoverer`, `createLogFollower`; `celldBucket(...).setShipper()`, `.setLog()`, `.session()`, `.flush()`.

A route to a cell's owner stays while calls keep reaching the owner through it (`routeTtlMs`, default 60 s since the last use): a node no longer opens and deletes a local database for every remote cell once a minute (#210). A log tier leader sends everything queued for a follower in one append.
