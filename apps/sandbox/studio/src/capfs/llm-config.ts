// Vendored from statewalker-sandbox/apps/flue-capfs-do (2641939, 2026-11-11); changes marked "studio:".
// The deployment's model (the `LLM` var) and the credentials of one run: the deployment's key
// (`LLM_API_KEY`) or the caller's own token. Apart from agent-loop.ts so it can be unit-tested.

export interface LlmConfig {
  baseUrl: string;
  model: string;
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  callerToken?: "allow" | "require" | "forbid";
  callerTokenHeader?: string;
  /** Runs on a caller's own token (as the API key) are not charged to the session's budget. */
  callerTokenUnmetered?: boolean;
}

const RESERVED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "host",
  "cookie",
  "connection",
  "transfer-encoding",
  "user-agent",
  "accept",
]);

/** Caller tokens: at least 8 characters a header and a JSON string carry as they are. */
const TOKEN = /^[A-Za-z0-9._~+/=:-]{8,4096}$/;

/** The deployment's model, or undefined when none is configured. */
export function llmConfig(env: { LLM?: unknown }): LlmConfig | undefined {
  const raw = env.LLM;
  if (raw === undefined || raw === null || raw === "") return undefined;
  let c: Partial<LlmConfig>;
  try {
    c = typeof raw === "string" ? JSON.parse(raw) : (raw as Partial<LlmConfig>);
  } catch {
    throw new Error("EINVAL: LLM is not valid JSON");
  }
  if (typeof c.baseUrl !== "string" || typeof c.model !== "string") {
    throw new Error("EINVAL: LLM needs baseUrl and model");
  }
  if (c.callerToken !== undefined && !["allow", "require", "forbid"].includes(c.callerToken))
    throw new Error("EINVAL: LLM callerToken is allow, require or forbid");
  if (c.callerTokenUnmetered !== undefined && typeof c.callerTokenUnmetered !== "boolean")
    throw new Error("EINVAL: LLM callerTokenUnmetered is true or false");
  if (c.callerTokenHeader !== undefined) {
    const h = c.callerTokenHeader;
    if (typeof h !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(h))
      throw new Error("EINVAL: LLM callerTokenHeader is not a header name");
    // The caller's token must not take the place of the deployment's credentials or of a header
    // the deployment sets (pi-ai merges model headers last).
    const lower = h.toLowerCase();
    if (
      RESERVED_HEADERS.has(lower) ||
      /^(content-|anthropic-|openai-|x-stainless-|sec-|proxy-)/.test(lower) ||
      Object.keys(c.headers ?? {}).some((k) => k.toLowerCase() === lower)
    )
      throw new Error(`EINVAL: LLM callerTokenHeader cannot be '${h}'`);
  }
  return c as LlmConfig;
}

/**
 * The API key and extra headers for one run: the deployment's key, or the caller's token
 * (as the key, or in `callerTokenHeader` beside the deployment's key), as `callerToken` allows.
 */
export function llmCredentials(c: LlmConfig, deploymentKey: string | undefined, llmToken?: string) {
  const policy = c.callerToken ?? "allow";
  if (llmToken !== undefined) {
    if (typeof llmToken !== "string" || !TOKEN.test(llmToken))
      throw new Error("EINVAL: the model token is not a valid credential");
    if (policy === "forbid") throw new Error("EACCES: this deployment does not take model tokens");
    if (c.callerTokenHeader)
      return { apiKey: deploymentKey, headers: { [c.callerTokenHeader]: llmToken } };
    // An Anthropic OAuth token would switch pi-ai into another client's mode (its system prompt,
    // tool names, headers): not the deployment's choice.
    if ((c.api ?? "openai-completions") === "anthropic-messages" && llmToken.includes("sk-ant-oat"))
      throw new Error("EINVAL: OAuth tokens are not taken as the model's API key");
    return { apiKey: llmToken, headers: {} };
  }
  if (policy === "require") throw new Error("EACCES: this deployment needs a model token");
  return { apiKey: deploymentKey, headers: {} };
}

/** Replaces each credential (as is, and as a JSON string would escape it) in a message. */
export function redactor(secrets: (string | undefined)[]) {
  const forms = secrets
    .filter((v): v is string => typeof v === "string" && v.length >= 4)
    .flatMap((v) => [v, JSON.stringify(v).slice(1, -1)])
    .sort((a, b) => b.length - a.length);
  return (s: string) => forms.reduce((t, v) => t.split(v).join("<redacted>"), s);
}
