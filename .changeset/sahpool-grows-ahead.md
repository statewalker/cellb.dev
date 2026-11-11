---
"@statewalker/cellb": patch
---

A browser runtime's OPFS pool (`sahpoolOpener`, used by `browserProjectRuntime`) grows ahead of its cells instead of once it is full. Each new slot is an OPFS file with a sync access handle, made one at a time, and in a busy worker each one takes seconds, about 5 s with 32 Flue conversations in one worker. Before, the pool counted only the files that already existed, so it did not see the journals open cells were about to create. Its background growth ran from a microtask that ran late under load. And a cell that found the pool full waited for it to double (64 more handles, minutes), which looked like a hang: 32 conversations in one worker stalled. Now an open cell counts the slots it does not hold yet (its journal and a spare), the background growth starts as each cell opens, and a waiting cell waits for growth in steps of 8 slots.
