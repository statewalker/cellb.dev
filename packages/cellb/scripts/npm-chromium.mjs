// Prints the path of a Chromium unpacked from the npm package @sparticuz/chromium.
// Used when Playwright's own browser CDN is unreachable (sandboxes, locked-down CI).
import chromium from "@sparticuz/chromium";

process.stdout.write(await chromium.executablePath());
