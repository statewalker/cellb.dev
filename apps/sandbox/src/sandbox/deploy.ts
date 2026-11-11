// A deployable folder of the project, made in the tab: the same app the preview runs, as a
// `no_bundle` Wrangler project that Cloudflare (`wrangler deploy`), celld (`celld dev .`) and
// cellb on Node run unchanged.
//
//   wrangler.json     the project's config, `main: "worker.js"`, `assets.directory: "assets"`
//   worker.js(.map)   the server, bundled by buildProject (packages/bundler)
//   assets/…          the client, exported from the running site (export.ts): pages and
//                     compiled modules, served by the host before the Worker is asked
//   migrations/…      D1 migrations, when the project has some
//   DEPLOY.md         how to run it on each host
//
// A client-only project gets an assets-only wrangler.json: no Worker, the same static site.

import type { ProjectFiles } from "./project";

export interface ServerBuild {
  config: Record<string, unknown>;
  files: Map<string, Uint8Array>;
}

const encoder = new TextEncoder();

export function deployReadme(name: string, server: boolean): string {
  return `# ${name}: deployable build

Made by CellB sandbox from the project's sources: ${server ? "the server bundled into `worker.js`, " : ""}the client
compiled into \`assets/\`. The same folder runs on every host below.

## Cloudflare

\`\`\`sh
npx wrangler deploy
\`\`\`

## celld (a fleet sharing one bucket)

\`\`\`sh
celld dev .
\`\`\`

## cellb on Node (the runtime the sandbox uses, outside the browser)

\`\`\`sh
npm install @statewalker/cellb
node serve.mjs            # http://localhost:8787, cells' data in .cellb-data/
\`\`\`

Durable Objects keep their state in each host's storage: the data of the sandbox's preview
stays in the browser (OPFS).
`;
}

/** cellb on Node, as a plain HTTP server over the folder (assets, Worker, Durable Objects). */
export const NODE_SERVER = `// node serve.mjs [port]: this folder on cellb, in Node (npm install @statewalker/cellb).
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { loadProject } from "@statewalker/cellb/node";

const dir = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2] ?? process.env.PORT ?? 8787);
const project = await loadProject(dir, { data: \`\${dir}.cellb-data\` });

createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, String(v));
    const response = await project.fetch(new Request(\`http://localhost:\${port}\${req.url}\`, { method: req.method, headers, body }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(err?.stack ?? err));
  }
}).listen(port, () => console.log(\`\${project.config.name ?? "app"} on http://localhost:\${port}\`));
`;

/**
 * A GitHub Actions workflow for the deploy branch: every push of a build deploys it to
 * Cloudflare. It needs the repository secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, and
 * a GitHub token with the "Workflows" permission to be pushed from the sandbox.
 */
export function deployWorkflow(branch: string): string {
  return `name: Deploy to Cloudflare
# Pushed by CellB sandbox with each build: this branch holds the deployable folder.
on:
  push:
    branches: [${branch}]
  workflow_dispatch: {}
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx wrangler@4 deploy
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
`;
}

/** The deployable folder from the server's build (if any) and the exported client (if any). */
export function assembleDeploy(opts: {
  name: string;
  compatibilityDate?: string;
  server?: ServerBuild;
  client?: ProjectFiles;
}): ProjectFiles {
  const out: ProjectFiles = new Map();
  let config: Record<string, unknown>;
  if (opts.server) {
    for (const [p, b] of opts.server.files) if (p !== "/wrangler.json") out.set(p, b);
    config = { ...opts.server.config };
  } else {
    config = {
      name: opts.name,
      compatibility_date: opts.compatibilityDate ?? new Date().toISOString().slice(0, 10),
    };
  }
  delete config.client; // the sandbox's own extension of the Wrangler file
  if (opts.client) {
    // Assets the project brought (its `assets.directory`) stay; the client wins on a clash.
    for (const [p, b] of opts.client) out.set(`/assets${p}`, b);
    const prev = (config.assets as Record<string, unknown> | undefined) ?? {};
    config.assets = { ...prev, directory: "assets" };
  }
  out.set("/wrangler.json", encoder.encode(`${JSON.stringify(config, null, 2)}\n`));
  out.set("/DEPLOY.md", encoder.encode(deployReadme(opts.name, !!opts.server)));
  out.set("/serve.mjs", encoder.encode(NODE_SERVER));
  return out;
}
