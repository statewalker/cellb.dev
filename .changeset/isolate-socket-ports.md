---
"@statewalker/cellb": patch
---

WebSockets into a loaded Worker (Worker Loader) no longer go through the isolate's multiplexed
port: a 101 answer hands the host the socket's own MessagePort, transferred, so its frames go
straight to the isolate. One isolate now holds any number of open sockets (it refused the
1,024th), with lower latency and more throughput (bench/README.md: echo p50 0.14 → 0.10 ms on
Node and 0.2 → 0.1 ms in Chromium; 64 KiB messages 65 → 192 MB/s on Node, 68 → 114 MB/s in
Chromium). The isolate's multiplexer allows 4,096 ports at once (for fetches and upgrades in
flight), as cellb's other port links do; `globalThis.__cellbMaxPorts` overrides it. When a
runtime closes, each isolate closes its sockets with 1001 before it ends. An upgrade into an
isolate fails when its port closes without an answer, instead of staying pending.
