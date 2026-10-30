# Build trace: app

**Succeeded.**

| step | events | ms (sum of timed events) |
|---|---|---|
| routes | 1 | 0 |
| packages | 22 | 4771 |
| transform | 10 | 327 |
| bundle | 7 | 32392 |
| run | 4 | 3397 |

## Timeline (timed events)

- 3894 ms · packages · astro -> npm:astro@7.4.4 (2713 ms)
- 4683 ms · packages · piccolore -> npm:piccolore@0.1.3 (203 ms)
- 4698 ms · packages · @oslojs/encoding -> npm:@oslojs/encoding@1.1.0 (219 ms)
- 4947 ms · packages · @astrojs/internal-helpers -> npm:@astrojs/internal-helpers@0.13.0 (217 ms)
- 5479 ms · packages · zod -> npm:zod@4.6.7 (710 ms)
- 10654 ms · bundle · pass 1 (compile, collect styles) (10626 ms)
- 11005 ms · transform · astro ~/src/pages/posts/[slug].astro (250 ms)
- 16171 ms · bundle · pass 2 (with the routes' styles) (5509 ms)
- 16268 ms · bundle · build the Worker (16257 ms)
- 19571 ms · run · evaluate the Worker module (3239 ms)
