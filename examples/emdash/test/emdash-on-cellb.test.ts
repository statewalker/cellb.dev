import { join } from "node:path";
import { loadNodeProject, nodeSqliteOpener } from "@statewalker/cellb/node";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { expect, it } from "vitest";

// The EmDash site as `astro build` emits it (Astro's Cloudflare adapter), on cellb in Node:
// D1, KV sessions, R2 media and the cron trigger served by cellb, nothing unsupported. Setup
// runs EmDash's own wizard endpoint, which applies the template's seed to D1 in steps.
const built = join(import.meta.dirname, "../dist/server");
const origin = "http://localhost";

it("serves the EmDash site: setup applies the seed, the pages render the posts", async () => {
  // On Cloudflare the canonical URL comes from `vars` through process.env (nodejs_compat); a
  // Node host shares its process with the Worker, so it is set here.
  process.env.EMDASH_SITE_URL = origin;
  const { runtime, unsupported } = await loadNodeProject(built, {
    openSql: nodeSqliteOpener(),
    files: new MemFilesApi(),
  });
  try {
    expect(unsupported).toEqual([]);
    const get = (path: string) =>
      runtime.fetch(new Request(`${origin}${path}`, { redirect: "manual" }));
    const status = await (await get("/_emdash/api/setup/status")).json();
    expect(status.data.needsSetup).toBe(true);

    // The wizard's first step, repeated while the seed reports more to do (as the admin does).
    let seeded = false;
    for (let i = 0; i < 10 && !seeded; i++) {
      const res = await runtime.fetch(
        new Request(`${origin}/_emdash/api/setup`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-emdash-request": "1", origin },
          body: JSON.stringify({
            title: "Cells in Node",
            tagline: "On cellb",
            includeContent: true,
          }),
        }),
      );
      expect(res.status).toBe(200);
      seeded = (await res.json()).data.seedComplete;
    }
    expect(seeded).toBe(true);

    const home = await get("/");
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain("Cells in Node");
    expect(html).toContain("Notes on Simplicity"); // a post of the template's seed

    const post = await get("/posts/notes-on-simplicity");
    expect(post.status).toBe(200);
    expect(await post.text()).toContain("Notes on Simplicity");

    const rss = await get("/rss.xml");
    expect(rss.status).toBe(200);
    expect(await rss.text()).toContain("<rss");

    // The admin answers with its sign-in, as setup now wants an account.
    const admin = await get("/_emdash/admin");
    expect([200, 302]).toContain(admin.status);
  } finally {
    await runtime.close();
  }
}, 180_000);
