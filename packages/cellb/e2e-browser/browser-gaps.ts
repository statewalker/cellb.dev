// Why a spec fails in a browser other than Chromium; docs/browser-host.md ("Firefox and WebKit")
// has the error text for each. Specs mark these `test.fail`, so a fix shows up as a failure.

type Browser = "chromium" | "firefox" | "webkit";
export type Gaps = Record<string, Partial<Record<Browser, string>>>;

export const SITE_HOST_DROPS_BODY =
  "Firefox: webrun-site-host rebuilds requests from request.body, so Worker Loader uploads arrive empty";
export const CLONE_MESSAGE =
  "Firefox words the structured-clone error differently from V8 (celld's golden)";
export const UNCONTROLLED_NAVIGATION =
  "Playwright's Firefox: a page loaded under an active ServiceWorker is not controlled";

/** The celld projects bundled into the worker (celld-projects.spec.ts). */
export const bundleGaps: Gaps = { "storage-details": { firefox: CLONE_MESSAGE } };

/** The same projects served by the in-browser site (site-projects.spec.ts). */
export const siteGaps: Gaps = {
  ...bundleGaps,
  ...Object.fromEntries(
    [
      "dynamic-worker-tails",
      "facets",
      "facets-api",
      "runtime-api",
      "isolation-api",
      "wd-worker-loader",
    ].map((name) => [name, { firefox: SITE_HOST_DROPS_BODY }]),
  ),
};
