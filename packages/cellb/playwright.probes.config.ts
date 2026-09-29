import base from "./playwright.config";
// Exploratory browser probes (hypothesis checks, printed measurements) — not part of `npm run e2e`.
export default { ...base, testDir: "browser/probes-e2e", testMatch: /.*\.probe\.spec\.ts/ };
