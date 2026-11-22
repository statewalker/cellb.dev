---
"@statewalker/cellb": minor
---

cellb leads and recovers sessions of celld's log tier, as a celld node does (#209). `cellb serve` (`startFleetNode`) leads unless `--durability bucket` (`CELLD_DURABILITY`): its commits are acknowledged once its followers (celld or cellb nodes) hold their LTX segments, or once the bucket does, whichever is first, with uploads kept in TXID order. Every node recovers the session of a dead leader, celld's or cellb's (claim, seal and tail the followers, upload what the bucket lacks, seal), unless it left celld node bundles. The node record is written by compare-and-swap and carries the session (`log`); a node that published one keeps its record, expired and sealed, when it closes. New exports in `src/peer`: `createLogLeader`, `createLogRecoverer`; `celldBucket(...).setShipper()`, `.setLog()`, `.session()`, `.flush()`.
