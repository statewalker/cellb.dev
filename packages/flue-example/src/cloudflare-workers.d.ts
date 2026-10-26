// The part of `cloudflare:workers` the app reads (the Worker's bindings and vars).
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
