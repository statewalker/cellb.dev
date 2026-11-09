// `cloudflare:workers` for unit tests on Node: the runtimes (workerd, celld, cellb) provide it.
export class DurableObject<Env = unknown> {
  constructor(
    public ctx: unknown,
    public env: Env,
  ) {}
}
