import { t as calculateCost, y as getIdentityHeaders } from "./models-CzbUlNE1.js";
import { n as headersToRecord, r as providerHeadersToRecord, t as retryProviderRequest } from "./provider-retry-CFUHzQ9h.js";
import { n as normalizeProviderError, t as formatProviderError } from "./error-body-wbW0Aj7-.js";
// ../../node_modules/.pnpm/@earendil-works+pi-ai@1.4.0_@aws-sdk+credential-provider-node@3.972.88_@modelcontextpro_db479a38ccb39f9d10e156b0123729f4/node_modules/@earendil-works/pi-ai/dist/api/classifier-shared.js
function httpError(label, response, body) {
	const error = /* @__PURE__ */ new Error(`${label} returned ${response.status}`);
	error.status = response.status;
	error.headers = response.headers;
	error.body = body;
	return error;
}
function timeoutError(timeoutMs) {
	const error = /* @__PURE__ */ new Error(`Request timed out after ${timeoutMs}ms`);
	error.name = "TimeoutError";
	error.status = void 0;
	error.headers = void 0;
	error.body = "";
	return error;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredNumber(label, value, field) {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} returned an invalid ${field}`);
	return value;
}
function requestHeaders(model, apiKey, optionsHeaders, identity) {
	return providerHeadersToRecord(getIdentityHeaders(model, identity), {
		authorization: `Bearer ${apiKey}`,
		"content-type": "application/json"
	}, model.headers, optionsHeaders) ?? {};
}
/**
* Posts one JSON classifier request with bearer auth, `onPayload`/`onResponse` hooks, a fresh
* timeout per attempt, and provider retries. Returns the parsed response body; throws on failure.
* `noRetryStatuses` lists HTTP statuses that fail at once although they are normally retried.
*/
async function postClassifierRequest(label, url, model, body, options, noRetryStatuses) {
	if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	const apiKey = options.apiKey;
	let payload = body;
	const transformed = await options.onPayload?.(payload, model);
	if (transformed !== void 0) payload = transformed;
	const requestFetch = options.fetch ?? globalThis.fetch;
	const { response, json } = await retryProviderRequest(async () => {
		const timeoutSignal = options.timeoutMs !== void 0 ? AbortSignal.timeout(options.timeoutMs) : void 0;
		const signal = options.signal && timeoutSignal ? AbortSignal.any([options.signal, timeoutSignal]) : options.signal ?? timeoutSignal;
		try {
			const next = await requestFetch(url, {
				method: "POST",
				headers: requestHeaders(model, apiKey, options.headers, options.identity),
				body: JSON.stringify(payload),
				signal
			});
			if (!next.ok) throw httpError(label, next, await next.text());
			return {
				response: next,
				json: await next.json()
			};
		} catch (error) {
			if (timeoutSignal?.aborted && !options.signal?.aborted) throw timeoutError(options.timeoutMs);
			throw error;
		}
	}, {
		maxRetries: options.maxRetries ?? 2,
		maxRetryDelayMs: options.maxRetryDelayMs,
		signal: options.signal,
		noRetryStatuses
	});
	await options.onResponse?.({
		status: response.status,
		headers: headersToRecord(response.headers)
	}, model);
	return json;
}
function tokenCount(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
/**
* Usage from a `{ input_tokens, output_tokens }` object, priced from the model catalog like chat
* usage. A missing or malformed usage object leaves the result without usage instead of failing it.
*/
function parseClassifierUsage(value, model) {
	if (!isRecord(value) || value.input_tokens === void 0 && value.output_tokens === void 0) return void 0;
	const input = tokenCount(value.input_tokens);
	const output = tokenCount(value.output_tokens);
	const usage = {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
	calculateCost(model, usage);
	return usage;
}
// ../../node_modules/.pnpm/@earendil-works+pi-ai@1.4.0_@aws-sdk+credential-provider-node@3.972.88_@modelcontextpro_db479a38ccb39f9d10e156b0123729f4/node_modules/@earendil-works/pi-ai/dist/api/system-one-shared.js
/** TypeSafe's opt-in header for its experimental image input. */
var IMAGE_OPT_IN_HEADERS = { "TypeSafe-Danger-Zone-Images": "true" };
function probabilities(label, value, id) {
	if (!isRecord(value)) throw new Error(`${label} returned invalid probabilities for ${id}`);
	return Object.fromEntries(Object.entries(value).map(([key, probability]) => [key, requiredNumber(label, probability, `probability for ${id}.${key}`)]));
}
function parseAnswers(label, value, context) {
	if (!isRecord(value)) throw new Error(`${label} returned an unexpected response`);
	const answers = [];
	for (const [id, question] of Object.entries(context.questions)) {
		const answer = value[id];
		if (!isRecord(answer)) throw new Error(`${label} did not return an answer for ${id}`);
		if (question.type === "choice") {
			if (answer.type !== "choice" || typeof answer.choice !== "string") throw new Error(`${label} did not return a choice answer for ${id}`);
			answers.push([id, {
				type: "choice",
				choice: answer.choice,
				probabilities: probabilities(label, answer.probabilities, id),
				confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`)
			}]);
		} else if (question.type === "score") {
			if (answer.type !== "score") throw new Error(`${label} did not return a score answer for ${id}`);
			answers.push([id, {
				type: "score",
				score: requiredNumber(label, answer.score, `score for ${id}`),
				confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`)
			}]);
		} else {
			if (answer.type !== "noul") throw new Error(`${label} did not return a bool answer for ${id}`);
			answers.push([id, {
				type: "bool",
				probability: requiredNumber(label, answer.noul, `probability for ${id}`)
			}]);
		}
	}
	return Object.fromEntries(answers);
}
var ASSET_FORMATS = {
	"image/png": "png",
	"image/jpeg": "jpeg"
};
var DATA_URL_TYPES = /* @__PURE__ */ new Set([
	"image/png",
	"image/jpeg",
	"image/webp"
]);
/** Clef accepts at most this many images per request. */
var MAX_DATA_URL_IMAGES = 4;
/** Adds the context images to `request` in the service's form. */
function addImages(label, model, input, images, request) {
	if (input === "images") {
		if (images.length > MAX_DATA_URL_IMAGES) throw new Error(`${label} accepts at most ${MAX_DATA_URL_IMAGES} images for ${model.id}, got ${images.length}`);
		request.images = images.map((image) => {
			if (!DATA_URL_TYPES.has(image.mimeType)) throw new Error(`${label} accepts PNG, JPEG, and WebP images for ${model.id}, got ${image.mimeType}`);
			return `data:${image.mimeType};base64,${image.data}`;
		});
		return;
	}
	if (input === "state-image-urls") {
		request.state = [...images.map((image) => ({
			type: "image_url",
			image_url: { url: `data:${image.mimeType};base64,${image.data}` }
		})), request.state];
		return;
	}
	const assets = {};
	images.forEach((image, index) => {
		const format = ASSET_FORMATS[image.mimeType];
		if (!format) throw new Error(`${label} accepts PNG and JPEG images for ${model.id}, got ${image.mimeType}`);
		assets[`<image-${index + 1}>`] = {
			type: "image",
			format,
			data_base64: image.data
		};
	});
	request.assets = assets;
	request.state = [...Object.keys(assets), request.state];
}
/** Maps public `bool` questions to TypeSafe's wire-level `noul` type. */
function wireRequest(context) {
	return {
		state: context.state,
		questions: Object.fromEntries(Object.entries(context.questions).map(([id, question]) => [id, question.type === "bool" ? {
			...question,
			type: "noul"
		} : question]))
	};
}
/** Runs one System One classification over the given transport. */
async function classifySystemOne(transport, model, context, options) {
	const output = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now()
	};
	try {
		if (model.api !== transport.api) throw new Error(`Unsupported classifier API: ${model.api}`);
		const request = wireRequest(context);
		let requestOptions = options;
		if (context.images?.length) {
			if (!model.input.includes("image")) throw new Error(`${transport.label} does not support image input for ${model.id}`);
			const detected = transport.detectCompat(model);
			const imageInput = model.compat?.imageInput ?? detected.imageInput;
			addImages(transport.label, model, imageInput, context.images, request);
			if (model.compat?.sendImageOptInHeader ?? detected.sendImageOptInHeader) requestOptions = {
				...options,
				headers: {
					...IMAGE_OPT_IN_HEADERS,
					...options?.headers
				}
			};
		}
		const body = await postClassifierRequest(transport.label, transport.url(model), model, transport.payload(model, request), requestOptions);
		const result = transport.output(body);
		const usage = parseClassifierUsage(result.usage, model);
		if (usage) output.usage = usage;
		output.answers = parseAnswers(transport.label, result.answers, context);
		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error), `${transport.label} error`);
		return output;
	}
}
// ../../node_modules/.pnpm/@earendil-works+pi-ai@1.4.0_@aws-sdk+credential-provider-node@3.972.88_@modelcontextpro_db479a38ccb39f9d10e156b0123729f4/node_modules/@earendil-works/pi-ai/dist/api/cloudflare-workers-ai-system-one.js
var LABEL = "Cloudflare Workers AI";
function cloudflareErrorMessage(errors) {
	if (Array.isArray(errors)) {
		const messages = errors.map((error) => isRecord(error) && typeof error.message === "string" ? error.message : void 0).filter((message) => message !== void 0);
		if (messages.length > 0) return `${LABEL} error: ${messages.join("; ")}`;
	}
	return `${LABEL} request failed`;
}
/**
* System One models on the Workers AI REST endpoint:
* `POST /accounts/{account}/ai/run` with `{ model, input }`. The REST API wraps the model
* output in Cloudflare's API envelope. Third-party models such as `typesafe/jev` add a run record:
* `{ success, result: { state: "Completed", result: { answers, usage } } }`.
* https://developers.cloudflare.com/ai/models/typesafe/jev/
* Cloudflare-hosted models such as `@cf/cloudflare/clef` return the output directly:
* `{ success, result: { model, answers, usage } }`.
* https://developers.cloudflare.com/workers-ai/models/clef/
*
* Clef models take images as an `images` list of data URLs. TypeSafe's models take them as
* System One `assets`, without TypeSafe's opt-in header. The catalog sets `compat.imageInput`;
* the model ID check only covers models without it.
*/
var transport = {
	api: "cloudflare-workers-ai-system-one",
	label: LABEL,
	detectCompat: (model) => ({
		imageInput: model.id.startsWith("@cf/cloudflare/clef") ? "images" : "assets",
		sendImageOptInHeader: false
	}),
	url: (model) => new URL("run", `${model.baseUrl.replace(/\/+$/u, "")}/`),
	payload: (model, request) => ({
		model: model.id,
		input: request
	}),
	output: (body) => {
		if (!isRecord(body)) throw new Error(`${LABEL} returned an unexpected response`);
		if (body.success === false) throw new Error(cloudflareErrorMessage(body.errors));
		const result = body.result;
		if (!isRecord(result)) throw new Error(`${LABEL} returned an unexpected response`);
		if ("answers" in result) return result;
		if (result.state !== "Completed") throw new Error(`${LABEL} run did not complete (state: ${String(result.state)})`);
		if (!isRecord(result.result)) throw new Error(`${LABEL} returned an unexpected response`);
		return result.result;
	}
};
/** Cloudflare Workers AI System One classification with public `bool` values mapped to wire-level `noul`. */
var classify = (model, context, options) => classifySystemOne(transport, model, context, options);
export { classify };

//# sourceMappingURL=cloudflare-workers-ai-system-one-Bnuq8_eV.js.map