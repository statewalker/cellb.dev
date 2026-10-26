import base from "./playwright.config";
// Exploratory browser probes (hypothesis checks, printed measurements) — not part of `npm run e2e`.
export default {
  ...base,
  testDir: "e2e-browser/probes",
  testMatch: /.*\.probe\.spec\.ts/,
  testIgnore: [],
};
