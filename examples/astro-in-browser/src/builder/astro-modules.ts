/**
 * Astro's own virtual modules for an on-demand server build, as its Vite plugins write them
 * (`astro:content` with live collections, `astro:assets`, `astro:config/server`,
 * `astro:middleware`, the logger), with the image service fixed to the no-op one.
 */
export function astroModule(
  spec: string,
  ctx: { root: string; hasLiveConfig: boolean; image: Record<string, unknown> },
): string | undefined {
  switch (spec) {
    case "astro:middleware":
      return `export * from "astro/virtual-modules/middleware.js";`;
    case "virtual:astro:logger":
      return `export default undefined; export const level = "info";`;
    case "astro:config/server":
    case "astro:config/client":
      return `export const i18n = undefined, base = "/", trailingSlash = "ignore", site = undefined, compressHTML = "jsx", build = { format: "directory" };`;
    case "astro:content":
      return `import { createGetLiveCollection, createGetLiveEntry, createGetCollection, createGetEntry } from "astro/content/runtime";
import { createConsoleLogger } from "astro/logger/console";
${ctx.hasLiveConfig ? `import { collections as liveCollections } from "/src/live.config.ts";` : "const liveCollections = {};"}
const logger = createConsoleLogger({ level: "info" });
export const getCollection = createGetCollection({ liveCollections, logger });
export const getEntry = createGetEntry({ liveCollections, logger });
export const getLiveCollection = createGetLiveCollection({ liveCollections });
export const getLiveEntry = createGetLiveEntry({ liveCollections });
export { defineCollection, defineLiveCollection } from "astro/content/config";`;
    case "virtual:astro:assets/fonts/internal":
      return `export const componentDataByCssVariable = new Map(), fontDataByCssVariable = new Map(), fontFamilyByCssVariable = new Map();`;
    case "astro:content-module-imports":
    case "astro:data-layer-content":
    case "astro:asset-imports":
      return `export default new Map();`;
    case "astro:react:opts":
      return `export default { experimentalReactChildren: false, experimentalDisableStreaming: false };`;
    case "virtual:astro:get-image":
      return `import { getImage as _gi } from "astro:assets"; export const getImage = _gi;`;
    case "virtual:image-service":
      return `export { default } from "astro/assets/services/noop";`;
    case "astro:assets": {
      const imageConfig = {
        ...ctx.image,
        service: { entrypoint: "astro/assets/services/noop", config: {} },
        domains: (ctx.image.domains as unknown) ?? [],
        remotePatterns: (ctx.image.remotePatterns as unknown) ?? [],
      };
      return `import { createConsoleLogger as _cl } from "astro/logger/console";
const _l = _cl({ level: "info" });
const _runtimeLogger = { info: (m) => _l.info(null, m), warn: (m) => _l.warn(null, m), error: (m) => _l.error(null, m) };
import { getImage as getImageInternal, getConfiguredImageService as _getConfiguredImageService } from "astro/assets";
export { isLocalService } from "astro/assets";
export { default as Image } from "astro/components/Image.astro";
export { default as Picture } from "astro/components/Picture.astro";
// No font providers in this build: the font component is never rendered (no CSS variable has data).
export function Font() { return ""; }
import { inferRemoteSize as inferRemoteSizeInternal } from "astro/assets/utils/inferRemoteSize.js";
export const imageConfig = ${JSON.stringify(imageConfig)};
Object.defineProperties(imageConfig, { assetQueryParams: { value: undefined, enumerable: false, configurable: true },
  staticImageConfig: { value: { base: "/", assetsDir: "_astro" }, enumerable: false, configurable: true } });
export const getConfiguredImageService = _getConfiguredImageService;
export const getImage = async (options) => await getImageInternal(options, imageConfig, _runtimeLogger);
export const inferRemoteSize = async (url) => inferRemoteSizeInternal(url, imageConfig);
export const viteFSConfig = {}, safeModulePaths = new Set(), fsDenyGlob = () => false;
export const outDir = new URL("file:///dist/client/"), serverDir = new URL("file:///dist/server/");`;
    }
  }
  return undefined;
}
