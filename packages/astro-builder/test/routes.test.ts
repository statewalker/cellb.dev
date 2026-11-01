import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { expect, it } from "vitest";
import { projectRoutes, routeFromPattern, sortRoutes } from "../src/index.ts";

const project = (paths: string[]) =>
  new MemFilesApi({ initialFiles: Object.fromEntries(paths.map((p) => [p, ""])) });

it("names the routes of src/pages as Astro does and orders them by its priority", async () => {
  const files = project([
    "/p/src/pages/index.astro",
    "/p/src/pages/about.astro",
    "/p/src/pages/posts/index.astro",
    "/p/src/pages/posts/new.astro",
    "/p/src/pages/posts/[slug].astro",
    "/p/src/pages/docs/[page].astro",
    "/p/src/pages/docs/[...rest].astro",
    "/p/src/pages/api/time.ts",
    "/p/src/pages/feed.xml.ts",
    "/p/src/pages/_draft.astro", // underscore: not a route
    "/p/src/pages/notes.md", // not a page this builder compiles
  ]);
  const routes = await projectRoutes(files, "/p");
  expect(new Map(routes.map((r) => [r.route, r.type]))).toEqual(
    new Map([
      ["/", "page"],
      ["/about", "page"],
      ["/posts", "page"],
      ["/posts/new", "page"],
      ["/posts/[slug]", "page"],
      ["/docs/[page]", "page"],
      ["/docs/[...rest]", "page"],
      ["/api/time", "endpoint"],
      ["/feed.xml", "endpoint"],
    ]),
  );
  // Astro's priority: more segments first; at one depth static before named parameters,
  // named parameters before rest parameters.
  const at = (route: string) => routes.findIndex((r) => r.route === route);
  expect(at("/posts/new")).toBeLessThan(at("/posts/[slug]"));
  expect(at("/docs/[page]")).toBeLessThan(at("/docs/[...rest]"));
  expect(at("/posts/[slug]")).toBeLessThan(at("/about"));

  const match = (route: string, path: string) =>
    new RegExp(routes.find((r) => r.route === route)?.pattern ?? "$^").test(path);
  expect(match("/posts/[slug]", "/posts/hello")).toBe(true);
  expect(match("/posts/[slug]", "/posts/a/b")).toBe(false);
  expect(match("/docs/[...rest]", "/docs/a/b/c")).toBe(true);
  expect(match("/feed.xml", "/feed.xml/")).toBe(false); // an endpoint with an extension is exact
  expect(match("/about", "/about/")).toBe(true);
  // Astro's RouteData names a rest parameter with its dots.
  expect(routes.find((r) => r.route === "/posts/[slug]")?.params).toEqual(["slug"]);
  expect(routes.find((r) => r.route === "/docs/[...rest]")?.params).toEqual(["...rest"]);
});

it("takes injected routes and orders them with the project's", () => {
  const injected = routeFromPattern("/_admin/[...path]", "pkg/admin.astro");
  expect(injected).toMatchObject({ type: "page", origin: "external", params: ["...path"] });
  const sorted = sortRoutes([injected, routeFromPattern("/_admin/login", "pkg/login.ts")]);
  expect(sorted.map((r) => r.route)).toEqual(["/_admin/login", "/_admin/[...path]"]);
});
