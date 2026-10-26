/**
 * The `cloudflare:email` module for Worker code run by cellb. cellb has no Email Routing,
 * so the module only lets code that imports it load (the Agents SDK imports `EmailMessage`
 * at top level); building a message throws.
 */
export class EmailMessage {
  constructor(_from: string, _to: string, _raw: unknown) {
    throw new Error("cloudflare:email is not supported by cellb");
  }
}
