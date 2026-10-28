// ../../node_modules/.pnpm/@earendil-works+pi-ai@1.4.0_@aws-sdk+credential-provider-node@3.972.88_@modelcontextpro_db479a38ccb39f9d10e156b0123729f4/node_modules/@earendil-works/pi-ai/dist/api/openai-prompt-cache.js
var OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
function clampOpenAIPromptCacheKey(key) {
	if (key === void 0) return void 0;
	const chars = Array.from(key);
	if (chars.length <= 64) return key;
	return chars.slice(0, 64).join("");
}
export { OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH, clampOpenAIPromptCacheKey };

//# sourceMappingURL=openai-prompt-cache-De5CgTDI.js.map