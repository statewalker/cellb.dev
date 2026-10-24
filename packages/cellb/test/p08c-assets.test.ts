import { describe, expect, it } from "vitest";
import { createAssets } from "../src/bindings/assets.js";

const enc = (s: string) => new TextEncoder().encode(s);
const files = new Map([
  ["/index.html", enc("root")],
  ["/docs/index.html", enc("docs")],
  ["/404.html", enc("missing")],
  ["/docs/404.html", enc("docs missing")],
]);
const get = (path: string, headers: HeadersInit = {}) =>
  new Request(`http://x${path}`, { headers });

// Behaviour beyond what celld's corpus pins down (assets-api covers the rest against celld).
describe("P08c static assets", () => {
  it("serves a nested index at dir/ (Cloudflare; celld 0.6.2–0.6.3 fall through here — a celld bug, note 18)", async () => {
    const a = createAssets(files, {}, false);
    const r = a.route(get("/docs/"))!;
    expect([r.status, await r.text()]).toEqual([200, "docs"]);
  });

  it("single-page-application returns /index.html with 200 for a miss", async () => {
    const a = createAssets(files, { not_found_handling: "single-page-application" }, false);
    const r = a.route(get("/some/client/route"))!;
    expect([r.status, await r.text()]).toEqual([200, "root"]);
  });

  it("404-page uses the nearest 404.html; with a Worker only for navigation requests", async () => {
    const alone = createAssets(files, { not_found_handling: "404-page" }, false);
    const r = alone.route(get("/docs/nope"))!;
    expect([r.status, await r.text()]).toEqual([404, "docs missing"]);
    const withWorker = createAssets(files, { not_found_handling: "404-page" }, true);
    expect(withWorker.route(get("/nope"))).toBeUndefined();
    const nav = withWorker.route(get("/nope", { "sec-fetch-mode": "navigate" }))!;
    expect([nav.status, await nav.text()]).toEqual([404, "missing"]);
  });

  it("run_worker_first: true sends every request to the Worker", () => {
    expect(createAssets(files, { run_worker_first: true }, true).route(get("/"))).toBeUndefined();
  });

  it("force-trailing-slash: pages live at /x/ (celld 0.6.2–0.6.3 404 there — bug)", async () => {
    const f = new Map([...files, ["/about.html", enc("about")]]);
    const a = createAssets(f, { html_handling: "force-trailing-slash" }, false);
    const about = a.route(get("/about/"))!;
    expect([about.status, await about.text()]).toEqual([200, "about"]);
    const docs = a.route(get("/docs/"))!;
    expect([docs.status, await docs.text()]).toEqual([200, "docs"]);
    expect(a.route(get("/about"))!.headers.get("location")).toBe("/about/");
  });

  it("drop-trailing-slash: /x/ redirects to /x (celld 0.6.2–0.6.3 404 — bug)", () => {
    const f = new Map([...files, ["/about.html", enc("about")]]);
    const a = createAssets(f, { html_handling: "drop-trailing-slash" }, false);
    const r = a.route(get("/about/"))!;
    expect([r.status, r.headers.get("location")]).toEqual([307, "/about"]);
    expect(a.route(get("/docs/"))!.headers.get("location")).toBe("/docs");
  });
});
