# Build trace: emdash

**Succeeded.**

| step | events | ms (sum of timed events) |
|---|---|---|
| packages | 556 | 18848 |
| sources | 1 | 0 |
| config | 2 | 8664 |
| integrations | 1 | 0 |
| routes | 1 | 0 |
| transform | 75 | 713 |
| resolve | 225 | 0 |
| virtual | 34 | 7 |
| bundle | 17 | 183854 |

## Timeline (timed events)

- 18808 ms · packages · prefetched 229 packages, 16 at a time (from the lock) (7850 ms)
- 24073 ms · packages · preload for build-time code (5263 ms)
- 32737 ms · config · run astro.config.mjs and the integrations (8664 ms)
- 33403 ms · transform · scanned 65 components for the client build (645 ms)
- 38970 ms · packages · date-fns -> npm:date-fns@4.4.0 (201 ms)
- 45100 ms · packages · @date-fns/tz -> npm:@date-fns/tz@1.5.0 (259 ms)
- 69051 ms · bundle · server bundle (35647 ms)
- 76934 ms · packages · react-dom -> npm:react-dom@19.3.1 (791 ms)
- 105529 ms · bundle · client islands + renderers (36471 ms)
- 106476 ms · bundle · script npm:astro@7.4.4/components/ClientRouter.astro?astro&type=script&index=0&lang.ts FAILED (383 ms)
- 106476 ms · bundle · client bundle (37418 ms)
- 106584 ms · bundle · build the Worker (73847 ms)
