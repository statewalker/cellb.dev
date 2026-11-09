/** The bindings and variables of the platform's Worker, which every app reads a part of. */
export interface PlatformEnv {
  REGISTRY: DurableObjectNamespace;
  CDN: DurableObjectNamespace;
  PROJECTS: DurableObjectNamespace;
  BUILDS: DurableObjectNamespace;
  NOTEBOOKS: DurableObjectNamespace;
  /** Worker Loader: where Astro builds run on hosts whose realms cannot evaluate code. */
  LOADER?: unknown;
  REGISTRY_URL?: string;
  PACKUMENT_TTL_S?: string;
  /** Build tier limits: a build of more input bytes than this waits for a Node runner. */
  IN_OBJECT_BUILD_MAX_BYTES?: string;
}
