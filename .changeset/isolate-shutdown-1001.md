---
"@statewalker/cellb": patch
---

When a runtime closes, every socket into a loaded Worker's isolate hears 1001 at once, including those whose server end the Worker never accepted. Before, such a socket's client learned only through the heartbeat (1006, after about 20 s). A 101 from an isolate now carries the frames its server sent before the response was handed over (partyserver greets in `onConnect`), and the host's end replays them, so the socket's own port goes to the client and no relay stays in the isolate for the socket's life.
