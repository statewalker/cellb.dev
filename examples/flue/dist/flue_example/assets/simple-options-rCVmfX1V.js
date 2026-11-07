import { t as __commonJSMin } from "./rolldown-runtime-DQp2zzRu.js";
import { g as getSystemMessageText, n as clampThinkingLevel } from "./models-CzbUlNE1.js";
import * as m from "node:fs";
// builtin:esm-external-require-node:fs
var require_builtin_esm_external_require_node_fs = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = m.default;
}));
// ../../node_modules/.pnpm/@earendil-works+pi-ai@1.4.0_@aws-sdk+credential-provider-node@3.972.88_@modelcontextpro_db479a38ccb39f9d10e156b0123729f4/node_modules/@earendil-works/pi-ai/dist/utils/provider-env.js
var procEnvCache = null;
/**
* Fallback for https://github.com/oven-sh/bun/issues/27802.
* Bun compiled binaries can expose an empty process.env inside Linux sandboxes
* even though /proc/self/environ contains the environment.
*
* This intentionally duplicates restoreSandboxEnv() in
* packages/coding-agent/src/bun/restore-sandbox-env.ts. The ai package can be
* used directly, without going through that entrypoint, so provider env lookup
* must not depend on process.env having been patched.
*/
function getBunSandboxEnvValue(name) {
	if (typeof process === "undefined" || !process.versions?.bun || Object.keys(process.env).length > 0) return;
	if (procEnvCache === null) {
		procEnvCache = /* @__PURE__ */ new Map();
		try {
			const { readFileSync } = require_builtin_esm_external_require_node_fs();
			const data = readFileSync("/proc/self/environ", "utf-8");
			for (const entry of data.split("\0")) {
				const idx = entry.indexOf("=");
				if (idx > 0) procEnvCache.set(entry.slice(0, idx), entry.slice(idx + 1));
			}
		} catch {}
	}
	return procEnvCache.get(name);
}
/**
* Resolve a provider env value from scoped overrides, normal process.env, then
* the duplicated Bun sandbox fallback for direct pi-ai consumers.
*/
function getProviderEnvValue(name, env) {
	return env?.[name] || (typeof process !== "undefined" ? process.env[name] : void 0) || getBunSandboxEnvValue(name) || void 0;
}
// ../../node_modules/.pnpm/@earendil-works+pi-ai@1.4.0_@aws-sdk+credential-provider-node@3.972.88_@modelcontextpro_db479a38ccb39f9d10e156b0123729f4/node_modules/@earendil-works/pi-ai/dist/api/github-copilot-headers.js
function inferCopilotInitiator(messages) {
	const last = messages[messages.length - 1];
	return last && last.role !== "user" ? "agent" : "user";
}
function hasCopilotVisionInput(messages) {
	return messages.some((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) return msg.content.some((c) => c.type === "image");
		if (msg.role === "toolResult" && Array.isArray(msg.content)) return msg.content.some((c) => c.type === "image");
		return false;
	});
}
function buildCopilotDynamicHeaders(params) {
	const headers = {
		"X-Initiator": inferCopilotInitiator(params.messages),
		"Openai-Intent": "conversation-edits"
	};
	if (params.hasImages) headers["Copilot-Vision-Request"] = "true";
	return headers;
}
// ../../node_modules/.pnpm/@earendil-works+pi-ai@1.4.0_@aws-sdk+credential-provider-node@3.972.88_@modelcontextpro_db479a38ccb39f9d10e156b0123729f4/node_modules/@earendil-works/pi-ai/dist/utils/estimate.js
var CHARS_PER_TOKEN = 3.5;
var ESTIMATED_IMAGE_CHARS = 4800;
function calculateContextTokens(usage) {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function safeJsonStringify(value) {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}
function estimateTextAndImageContentChars(content) {
	if (typeof content === "string") return content.length;
	let chars = 0;
	for (const block of content) chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
	return chars;
}
function estimateTextTokens(text) {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}
function estimateTextAndImageContentTokens(content) {
	return Math.ceil(estimateTextAndImageContentChars(content) / CHARS_PER_TOKEN);
}
function estimateMessageTokens(message) {
	let chars = 0;
	if (message.role === "system") return estimateTextTokens(getSystemMessageText(message)) + estimateToolsTokens(message.toolsAdded) + estimateToolsTokens(message.toolsRemoved);
	if (message.role === "user") return estimateTextAndImageContentTokens(message.content);
	if (message.role === "toolResult") return estimateTextAndImageContentTokens(message.content);
	for (const block of message.content) if (block.type === "text") chars += block.text.length;
	else if (block.type === "thinking") chars += block.thinking.length;
	else chars += block.name.length + safeJsonStringify(block.arguments).length;
	return Math.ceil(chars / CHARS_PER_TOKEN);
}
function getLastAssistantUsageInfo(messages) {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			const assistant = message;
			if (assistant.timestamp >= latestPrefixTimestamp && assistant.stopReason !== "aborted" && assistant.stopReason !== "error" && calculateContextTokens(assistant.usage) > 0) usageInfo = {
				usage: assistant.usage,
				index: i
			};
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}
	return usageInfo;
}
function estimateContextTokens(context) {
	const messages = "messages" in context ? context.messages : context;
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (usageInfo) {
		const usageTokens = calculateContextTokens(usageInfo.usage);
		let trailingTokens = 0;
		for (let i = usageInfo.index + 1; i < messages.length; i++) trailingTokens += estimateMessageTokens(messages[i]);
		return {
			tokens: usageTokens + trailingTokens,
			usageTokens,
			trailingTokens,
			lastUsageIndex: usageInfo.index
		};
	}
	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return {
		tokens,
		usageTokens: 0,
		trailingTokens: tokens,
		lastUsageIndex: null
	};
}
function estimateToolsTokens(tools) {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}
// ../../node_modules/.pnpm/@earendil-works+pi-ai@1.4.0_@aws-sdk+credential-provider-node@3.972.88_@modelcontextpro_db479a38ccb39f9d10e156b0123729f4/node_modules/@earendil-works/pi-ai/dist/api/simple-options.js
var CONTEXT_SAFETY_TOKENS = 4096;
var MIN_MAX_TOKENS = 1;
function clampMaxTokensToContext(model, context, maxTokens) {
	if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
	const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
	return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}
function resolveSamplingParams(model, thinkingLevel, requestParams) {
	const effectiveThinkingLevel = clampThinkingLevel(model, thinkingLevel);
	const thinkingLevelParams = model.samplingParamsByThinkingLevel?.[effectiveThinkingLevel];
	return model.samplingParams || thinkingLevelParams || requestParams ? {
		...model.samplingParams,
		...thinkingLevelParams,
		...requestParams
	} : void 0;
}
function buildBaseOptions(model, context, options, apiKey) {
	const samplingParams = resolveSamplingParams(model, options?.reasoning ?? "off", options?.samplingParams);
	return {
		temperature: options?.temperature,
		samplingParams,
		maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),
		signal: options?.signal,
		telemetry: options?.telemetry,
		apiKey: apiKey || options?.apiKey,
		fetch: options?.fetch,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		headers: options?.headers,
		identity: options?.identity,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onProviderStreamEvent: options?.onProviderStreamEvent,
		timeoutMs: options?.timeoutMs,
		websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		env: options?.env
	};
}
/** Tokens always left for the answer when a thinking budget shares the response ceiling. */
var MIN_ANSWER_TOKENS = 1024;
var DEFAULT_THINKING_BUDGETS = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384
};
function clampReasoning(effort) {
	return effort === "xhigh" || effort === "max" ? "high" : effort;
}
function thinkingBudgetForLevel(reasoningLevel, customBudgets) {
	return {
		...DEFAULT_THINKING_BUDGETS,
		...customBudgets
	}[clampReasoning(reasoningLevel)];
}
/** Cap a thinking budget so at least MIN_ANSWER_TOKENS remain under a shared response ceiling. */
function clampThinkingBudgetToAnswerRoom(thinkingBudget, ceiling) {
	return Math.min(thinkingBudget, Math.max(0, ceiling - MIN_ANSWER_TOKENS));
}
function adjustMaxTokensForThinking(baseMaxTokens, modelMaxTokens, reasoningLevel, customBudgets) {
	let thinkingBudget = thinkingBudgetForLevel(reasoningLevel, customBudgets);
	const maxTokens = baseMaxTokens === void 0 ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);
	if (maxTokens <= thinkingBudget) thinkingBudget = clampThinkingBudgetToAnswerRoom(thinkingBudget, maxTokens);
	return {
		maxTokens,
		thinkingBudget
	};
}
export { resolveSamplingParams as a, hasCopilotVisionInput as c, clampThinkingBudgetToAnswerRoom as i, getProviderEnvValue as l, buildBaseOptions as n, thinkingBudgetForLevel as o, clampMaxTokensToContext as r, buildCopilotDynamicHeaders as s, adjustMaxTokensForThinking as t };

//# sourceMappingURL=simple-options-rCVmfX1V.js.map