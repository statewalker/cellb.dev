---
"@statewalker/cellb": patch
---

Depends on `@statewalker/webrun-http-browser` 0.12.2, which counts a WebSocket message's UTF-8 size natively instead of in a JavaScript loop. Both ends of every socket count each message, and the loop held 64 KiB echoes into a loaded Worker at about 75 MB/s on Node. With 0.12.2 (bench/README.md): 64 KiB messages 227 MB/s on Node and 132 MB/s in Chromium, 1 KiB messages 32,665 and 15,917 per second, echo p50 0.09 ms and 0.1 ms.
