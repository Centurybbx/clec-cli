import { sha256Buffer, type ExecutionClosure } from "./pins.ts";
import { isSafeTokenId, isSha256Hex, makeAttemptId, type AttemptId, type RunId, type Sha256Hex, UNIT1_LIMITS } from "./types.ts";

type CaseId = string & { readonly __brand: "CaseId" };
type PredecessorId = string & { readonly __brand: "PredecessorId" };
type PlanDigest = Sha256Hex & { readonly __plan: "PublicRunPlan" };

export type AttemptIdentity = { readonly caseId: CaseId; readonly attemptId: AttemptId } & (
	| { readonly ordinal: 1; readonly predecessor: null }
	| { readonly ordinal: 2; readonly predecessor: PredecessorId }
);

export const STATUS_SCHEMA = {
	type: "object", additionalProperties: false, properties: { action: { const: "status", type: "string" } },
	required: ["action"],
};

export const STATUS_CORPUS = Object.freeze({
	kind: "synthetic-empty-offline-v1", index: null, archive: null, activePointer: null, database: null,
});

export const RUN_LIMITS = Object.freeze({ ...UNIT1_LIMITS, globalReplacements: 1, runDeadlineMs: 90 * 60_000 });

export function proofSettings(provider: string, model: string, thinking: string) {
	return {
		defaultProvider: provider, defaultModel: model, defaultThinkingLevel: thinking,
		compaction: { enabled: false }, cacheWarming: "off",
		retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
		enableInstallTelemetry: false, enableAnalytics: false, defaultTools: [],
	};
}

export function settingsBytes(provider: string, model: string, thinking: string): string {
	return JSON.stringify(proofSettings(provider, model, thinking), null, 2);
}

export const SYSTEM_PROMPT = "Collect the result of the synthetic, status-only CLEC control.";

export function systemSections(cwd: string) {
	return { preamble: SYSTEM_PROMPT, cwd: `<cwd>\n${cwd}\n</cwd>` };
}

export function systemPrompt(cwd: string): string {
	return Object.values(systemSections(cwd)).join("\n\n");
}

function promptDigest(): Sha256Hex {
	return digest({ prefix: UNIT1_LIMITS.promptPrefix, sections: systemSections("{attempt_cwd}") });
}

export const PROOF_MODEL = Object.freeze({ provider: "mock-openai", model: "mock-gpt", thinking: "off" });

export function digest(value: unknown): Sha256Hex {
	return sha256Buffer(JSON.stringify(value));
}

function isCaseId(input: unknown): input is CaseId {
	return isSafeTokenId(input) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(input);
}

function isPredecessor(input: string): input is PredecessorId {
	return isSafeTokenId(input);
}

export function initialAttempt(runId: RunId, caseId: CaseId): AttemptIdentity {
	return { caseId, attemptId: makeAttemptId(`${runId}-${caseId}-a1`), ordinal: 1, predecessor: null };
}

export function replacement(runId: RunId, prior: AttemptIdentity): AttemptIdentity {
	if (prior.ordinal !== 1 || !isPredecessor(prior.attemptId)) throw new Error("replacement_predecessor");
	return { caseId: prior.caseId, attemptId: makeAttemptId(`${runId}-${prior.caseId}-a2`), ordinal: 2, predecessor: prior.attemptId };
}

export function runtimeInventory({ capturedUtc: _capturedUtc, ...inventory }: ExecutionClosure) {
	return inventory;
}

export function publicProfile(closure: ExecutionClosure) {
	return {
		source: digest(closure.unit1Files),
		runtimeIdentity: digest(runtimeInventory(closure)),
		runtime: closure.closureDigest, skill: closure.skillPin.sha256,
		corpus: digest(STATUS_CORPUS), prompt: promptDigest(), schema: digest(STATUS_SCHEMA),
		settings: sha256Buffer(settingsBytes(PROOF_MODEL.provider, PROOF_MODEL.model, PROOF_MODEL.thinking)),
		model: PROOF_MODEL, limits: RUN_LIMITS,
	};
}

export type Profile = ReturnType<typeof publicProfile>;
type PublicCase = Readonly<{ id: CaseId; question: string; questionSha256: Sha256Hex }>;
export type PublicRunPlan = Readonly<{ version: 1; profile: Profile; cases: readonly [PublicCase, ...PublicCase[]] }>;
export type ExpectedCommitments = Readonly<{ version: 1; runId: RunId; plan: PlanDigest; profile: Sha256Hex; originalRoot: string }>;

export function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parsePlan(input: unknown, profile: Profile): PublicRunPlan {
	if (!object(input) || input.version !== 1 || digest(input.profile ?? null) !== digest(profile) ||
		!Array.isArray(input.cases)) throw new Error("plan_profile");
	const ids = new Set<CaseId>();
	const cases = input.cases.map((item: unknown): PublicCase => {
		if (!object(item) || !isCaseId(item.id) || typeof item.question !== "string" ||
			item.question.length === 0 || Buffer.byteLength(item.question) > UNIT1_LIMITS.answerBytes ||
			Buffer.from(item.question).toString("utf8") !== item.question ||
			item.questionSha256 !== sha256Buffer(item.question) || ids.has(item.id)) throw new Error("plan_case");
		ids.add(item.id);
		return Object.freeze({ id: item.id, question: item.question, questionSha256: sha256Buffer(item.question) });
	});
	const [first, ...rest] = cases;
	if (!first) throw new Error("plan_empty");
	const plan: PublicRunPlan = { version: 1, profile, cases: Object.freeze([first, ...rest]) };
	if (digest(input) !== digest(plan)) throw new Error("plan_shape");
	return Object.freeze(plan);
}

function isPlanDigest(value: unknown): value is PlanDigest {
	return isSha256Hex(value);
}

export function anchorFor(runId: RunId, plan: PublicRunPlan, originalRoot: string): ExpectedCommitments {
	const hash = digest(plan);
	if (!isPlanDigest(hash)) throw new Error("plan_digest");
	return Object.freeze({ version: 1, runId, plan: hash, profile: digest(plan.profile), originalRoot });
}

export function deepEqualJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null || typeof a !== typeof b) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((v, i) => deepEqualJson(v, b[i]));
	}
	if (typeof a === "object" && typeof b === "object") {
		const aObj = a as Record<string, unknown>;
		const bObj = b as Record<string, unknown>;
		const aKeys = Object.keys(aObj).sort();
		const bKeys = Object.keys(bObj).sort();
		if (aKeys.length !== bKeys.length) return false;
		return aKeys.every((k, i) => k === bKeys[i] && deepEqualJson(aObj[k], bObj[k]));
	}
	return false;
}

export function extractUserContentText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (
		Array.isArray(content) &&
		content.length === 1 &&
		content[0] !== null &&
		typeof content[0] === "object"
	) {
		const block = content[0] as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") {
			return block.text;
		}
	}
	return null;
}

export function validateProviderPayload(params: {
	readonly payloadJson: string;
	readonly expectedModelId: string;
	readonly expectedEncodedPrompt: string;
	readonly expectedSystemPrompt?: string;
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(params.payloadJson);
	} catch (err) {
		return { ok: false, reason: `Payload JSON invalid: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, reason: "Payload is not an object" };
	}
	const obj = parsed as Record<string, unknown>;
	if (obj.model !== params.expectedModelId) {
		return { ok: false, reason: `Unexpected model in payload: ${String(obj.model)}` };
	}
	if (!Array.isArray(obj.messages) || obj.messages.length === 0) {
		return { ok: false, reason: "Payload messages missing or empty" };
	}
	if (params.expectedSystemPrompt !== undefined) {
		const [system, user] = obj.messages;
		if (!object(system) || system.role !== "system" || system.content !== params.expectedSystemPrompt ||
			!object(user) || user.role !== "user") return { ok: false, reason: "Provider system prompt drift" };
	}
	const firstUser = obj.messages.find(
		(m) => m && typeof m === "object" && (m as Record<string, unknown>).role === "user",
	) as Record<string, unknown> | undefined;
	const firstUserText = firstUser ? extractUserContentText(firstUser.content) : null;
	if (firstUserText !== params.expectedEncodedPrompt) {
		return { ok: false, reason: `Payload user prompt does not match encoded literal prompt (got=${JSON.stringify(firstUser?.content)})` };
	}
	if (!Array.isArray(obj.tools) || obj.tools.length !== 1) {
		return { ok: false, reason: `Expected exactly 1 tool in payload, got ${Array.isArray(obj.tools) ? obj.tools.length : "none"}` };
	}
	const tool0 = obj.tools[0] as Record<string, unknown> | undefined;
	const fn = tool0?.function as Record<string, unknown> | undefined;
	if (tool0?.type !== "function" || fn?.name !== "clec") {
		return { ok: false, reason: `Unexpected tool declaration: ${JSON.stringify(tool0)}` };
	}
	if (!deepEqualJson(fn?.parameters, STATUS_SCHEMA)) {
		return { ok: false, reason: `CLEC tool schema drift: ${JSON.stringify(fn?.parameters)}` };
	}
	return { ok: true };
}


export function parseProfile(value: unknown): Profile {
	if (!object(value) || !isSha256Hex(value.source) || !isSha256Hex(value.runtimeIdentity) ||
		!isSha256Hex(value.runtime) || !isSha256Hex(value.skill)) throw new Error("plan_profile");
	const profile = {
		source: value.source, runtimeIdentity: value.runtimeIdentity, runtime: value.runtime, skill: value.skill,
		corpus: digest(STATUS_CORPUS), prompt: promptDigest(), schema: digest(STATUS_SCHEMA),
		settings: sha256Buffer(settingsBytes(PROOF_MODEL.provider, PROOF_MODEL.model, PROOF_MODEL.thinking)),
		model: PROOF_MODEL, limits: RUN_LIMITS,
	};
	if (digest(profile) !== digest(value)) throw new Error("plan_profile");
	return profile;
}
