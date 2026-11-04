// Stands in for lightningcss-wasm in the site's build. cellb's createProjectSite compiles CSS with
// it (through @statewalker/webrun-modules). The homepage demo runs a bundle, not a site, so it
// never calls it, but the import would still ship its 16 MB .wasm with the page.
export default async function init(): Promise<void> {
  throw new Error("lightningcss-wasm is not part of the cellb.dev site build");
}
export function transform(): never {
  throw new Error("lightningcss-wasm is not part of the cellb.dev site build");
}
