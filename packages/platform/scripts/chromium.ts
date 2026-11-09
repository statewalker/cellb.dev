/**
 * Launch options for Chromium: `PW_CHROMIUM` names a binary (as in cellb's own suites: the
 * repository's Playwright may expect a browser build that is not installed), and the proxy where
 * outbound HTTPS has one (pages fetch packages from registry.npmjs.org).
 */
export function chromiumOptions(): Record<string, unknown> {
  return {
    ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
    ...(process.env.HTTPS_PROXY
      ? { proxy: { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } }
      : {}),
  };
}
