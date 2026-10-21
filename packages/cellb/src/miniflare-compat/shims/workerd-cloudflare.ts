/**
 * workerd's `Cloudflare` global (compatibility flags), injected by esbuild into the
 * vendored workerd binding clients. No flags set = default behaviour.
 */
export const Cloudflare = { compatibilityFlags: {} as Record<string, boolean> };
