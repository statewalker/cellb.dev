# Build trace: emdash

**Succeeded.**

| step | events | ms (sum of timed events) |
|---|---|---|
| packages | 556 | 11335 |
| sources | 1 | 0 |
| config | 2 | 6787 |
| integrations | 1 | 0 |
| routes | 1 | 0 |
| transform | 75 | 418 |
| resolve | 225 | 0 |
| virtual | 34 | 16 |
| bundle | 17 | 208055 |

## Timeline (timed events)

- 1514 ms · packages · prefetched 229 packages, 16 at a time (from the lock) (983 ms)
- 6629 ms · packages · preload for build-time code (5113 ms)
- 13416 ms · config · run astro.config.mjs and the integrations (6787 ms)
- 13784 ms · transform · scanned 65 components for the client build (341 ms)
- 53638 ms · bundle · server bundle (39853 ms)
- 64228 ms · packages · lib0 -> npm:lib0@0.2.119 (522 ms)
- 95677 ms · bundle · client islands + renderers (42038 ms)
- 96420 ms · bundle · client bundle (42782 ms)
- 96525 ms · bundle · build the Worker (83109 ms)
