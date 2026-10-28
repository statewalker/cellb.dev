import { C as AssistantMessageEventStream, l as getDeclaredTools, m as resolveTranscriptTools, n as clampThinkingLevel, p as resolveTranscript, y as getIdentityHeaders } from "./models-CzbUlNE1.js";
import { a as resolveSamplingParams, c as hasCopilotVisionInput, l as getProviderEnvValue, n as buildBaseOptions, s as buildCopilotDynamicHeaders } from "./simple-options-rCVmfX1V.js";
import { n as headersToRecord, t as retryProviderRequest } from "./provider-retry-CFUHzQ9h.js";
import { i as createGrammarToolInputProperties } from "./transform-messages-niVPG_iW.js";
import { t as OpenAI } from "./openai-B6Lk23Y0.js";
import { n as normalizeProviderError, t as formatProviderError } from "./error-body-wbW0Aj7-.js";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache-De5CgTDI.js";
import { convertResponsesMessages, convertResponsesTools, getResponsesToolSupport, processResponsesStream } from "./openai-responses-shared-BgVmcCAA.js";
// ../../node_modules/.pnpm/@earendil-works+pi-ai@1.4.0_@aws-sdk+credential-provider-node@3.972.88_@modelcontextpro_db479a38ccb39f9d10e156b0123729f4/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js
var OPENAI_TOOL_CALL_PROVIDERS = /* @__PURE__ */ new Set([
	"openai",
	"openai-codex",
	"opencode"
]);
var OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
var CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
var CHATGPT_WORKSPACE_LIMIT_HINT = "You've reached your ChatGPT workspace's usage limit. Ask your workspace admin to increase it at admin.openai.com → Workspace → Usage limits.";
var CONFIGURATION_UPDATE_REQUEST_EFFORT = "medium";
/**
* OpenAI API keys start with `sk-`; a different credential sent directly to OpenAI
* is a Sign in with ChatGPT access token.
*/
function isChatGPTSignIn(model, apiKey) {
	return model.provider === "openai" && model.baseUrl === "https://api.openai.com/v1" && apiKey !== void 0 && !apiKey.startsWith("sk-");
}
function hasHeader(headers, name) {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	return false;
}
function getClientApiKey(provider, apiKey, headers) {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}
function detectSessionAffinityFormat(model) {
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}
/**
* Resolve cache retention preference.
* Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
*/
function resolveCacheRetention(cacheRetention, env) {
	if (cacheRetention) return cacheRetention;
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") return "long";
	return "short";
}
function getCompat(model) {
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
		supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
		supportsMidConvoEffort: model.compat?.supportsMidConvoEffort ?? false
	};
}
/** Effort to send in configuration_update items, or undefined to send it as reasoning.effort. */
function getConfigurationUpdateEffort(model, options, compat) {
	if (!compat.supportsMidConvoEffort || !options?.reasoningEffort || isChatGPTSignIn(model, options.apiKey)) return;
	return model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
}
function getPromptCacheRetention(compat, cacheRetention) {
	return cacheRetention === "long" && compat.supportsLongCacheRetention && !compat.supportsExplicitPromptCacheMode ? "24h" : void 0;
}
function getPromptCacheOptions(compat, cacheRetention) {
	if (!compat.supportsExplicitPromptCacheMode) return void 0;
	if (cacheRetention === "none") return { mode: "explicit" };
	if (cacheRetention === "long" && compat.supportsLongCacheRetention) return { ttl: "30m" };
}
/**
* Generate function for OpenAI Responses API
*/
var stream = (model, context, options) => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);
	(async () => {
		const compat = getCompat(model);
		const configurationUpdateEffort = getConfigurationUpdateEffort(model, options, compat);
		const output = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			...configurationUpdateEffort === void 0 ? {} : { providerThinkingLevel: configurationUpdateEffort },
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0
				}
			},
			stopReason: "pending",
			timestamp: Date.now()
		};
		try {
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const cacheSessionId = resolveCacheRetention(options?.cacheRetention, options?.env) === "none" ? void 0 : options?.sessionId;
			const grammarToolInputProperties = createGrammarToolInputProperties(getDeclaredTools(normalizedContext.messages), compat.supportsOpenAIGrammarTools);
			const client = createClient(model, normalizedContext, apiKey, options?.headers, options?.identity, options?.fetch, cacheSessionId);
			let params = buildParams(model, normalizedContext, options, compat, grammarToolInputProperties, configurationUpdateEffort);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== void 0) params = nextParams;
			const requestOptions = {
				...options?.signal ? { signal: options.signal } : {},
				...options?.timeoutMs !== void 0 ? { timeout: options.timeoutMs } : {},
				maxRetries: 0
			};
			const { data: openaiStream, response } = await retryProviderRequest(() => client.responses.create(params, requestOptions).withResponse(), {
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal
			});
			await options?.onResponse?.({
				status: response.status,
				headers: headersToRecord(response.headers)
			}, model);
			stream.push({
				type: "start",
				partial: output
			});
			await processResponsesStream(openaiStream, output, stream, model, {
				onProviderStreamEvent: options?.onProviderStreamEvent,
				serviceTier: options?.serviceTier,
				grammarToolInputProperties,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model)
			});
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "pending") throw new Error("OpenAI Responses stream ended without a stop reason");
			if (output.stopReason === "aborted" || output.stopReason === "error") throw new Error(output.errorMessage || "An unknown error occurred");
			stream.push({
				type: "done",
				reason: output.stopReason,
				message: output
			});
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete block.index;
				delete block.partialJson;
				delete block.customInput;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			const errorMessage = formatProviderError(normalizeProviderError(error), `${model.provider === "openai" ? "OpenAI" : model.provider} API error`);
			if (errorMessage.includes("subscription_sharing_usage_limit_exceeded")) output.errorMessage = `${errorMessage}\nCheck your ChatGPT usage: ${CHATGPT_USAGE_URL}`;
			else if (errorMessage.includes("subscription_sharing_workplace_individual_usage_limit_exceeded")) output.errorMessage = `${errorMessage}\n${CHATGPT_WORKSPACE_LIMIT_HINT}`;
			else output.errorMessage = errorMessage;
			stream.push({
				type: "error",
				reason: output.stopReason,
				error: output
			});
			stream.end();
		}
	})();
	return stream;
};
var streamSimple = (model, context, options) => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);
	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice
	};
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : void 0;
	const reasoningEffort = clampedReasoning === "off" ? void 0 : clampedReasoning;
	return stream(model, context, {
		...base,
		reasoningEffort
	});
};
function createClient(model, context, apiKey, optionsHeaders, identity, fetch, sessionId) {
	const compat = getCompat(model);
	const headers = {
		...getIdentityHeaders(model, identity),
		...model.headers
	};
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages
		});
		Object.assign(headers, copilotHeaders);
	}
	if (sessionId) {
		if (compat.sessionAffinityFormat === "openrouter") headers["x-session-id"] = sessionId;
		else {
			if (compat.sessionAffinityFormat === "openai") headers.session_id = sessionId;
			headers["x-client-request-id"] = sessionId;
		}
	}
	if (optionsHeaders) Object.assign(headers, optionsHeaders);
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers
	});
}
function buildParams(model, context, options, compat, grammarToolInputProperties, configurationUpdateEffort) {
	const transcriptTools = resolveTranscriptTools(context.messages, getResponsesToolSupport(compat));
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
		supportsAdditionalTools: compat.supportsAdditionalTools,
		supportsToolSearch: compat.supportsToolSearch,
		toolOptions: {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools
		},
		configurationUpdateEffort
	});
	const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
	const omitUnsupportedFields = isChatGPTSignIn(model, options?.apiKey);
	const params = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? void 0 : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: omitUnsupportedFields ? void 0 : getPromptCacheRetention(compat, cacheRetention),
		prompt_cache_options: omitUnsupportedFields ? void 0 : getPromptCacheOptions(compat, cacheRetention),
		store: false
	};
	if (options?.maxTokens && compat.supportsMaxOutputTokens && !omitUnsupportedFields) params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	if (options?.temperature !== void 0 && !omitUnsupportedFields) params.temperature = options?.temperature;
	if (options?.serviceTier !== void 0) params.service_tier = options.serviceTier;
	if (transcriptTools.requestTools.length > 0) params.tools = convertResponsesTools(transcriptTools.requestTools, {
		supportsStrictMode: compat.supportsStrictMode,
		supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools
	});
	if (options?.toolChoice !== void 0) params.tool_choice = options.toolChoice;
	const reasoningEffort = options?.reasoningEffort ?? (options?.reasoningSummary ? "medium" : void 0);
	if (model.reasoning) {
		if (reasoningEffort) {
			const requestedEffort = options?.reasoningEffort ? model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort : reasoningEffort;
			params.reasoning = {
				effort: configurationUpdateEffort === void 0 ? requestedEffort : CONFIGURATION_UPDATE_REQUEST_EFFORT,
				summary: options?.reasoningSummary || "auto"
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) params.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
		if (model.provider === "xai") params.include = ["reasoning.encrypted_content"];
	}
	const samplingParams = resolveSamplingParams(model, reasoningEffort ?? "off", options?.samplingParams);
	if (samplingParams) Object.assign(params, samplingParams);
	return params;
}
function getServiceTierCostMultiplier(model, serviceTier) {
	switch (serviceTier) {
		case "flex": return .5;
		case "priority":
		case "fast": return model.id === "gpt-5.5" ? 2.5 : 2;
		default: return 1;
	}
}
function applyServiceTierPricing(usage, serviceTier, model) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
export { stream, streamSimple };

//# sourceMappingURL=openai-responses-DHrlglv3.js.map