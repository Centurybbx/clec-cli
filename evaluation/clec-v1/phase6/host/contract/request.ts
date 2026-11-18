import { isSha256Hex, type Sha256Hex, HOST_LIMITS } from "./types.ts";

const LIMITS = {
	maxStdoutBytesPerCall: HOST_LIMITS.nativeStdoutBytes,
	maxQueryUtf8Bytes: 2048,
	maxQueriesPerSearch: 4,
	maxSearchLimit: 5,
	maxSearchPerWork: 5,
	maxReadIds: 50,
	maxReadContext: 2,
	maxSourcesLimit: 100,
	maxSourcesOffset: 1_000_000,
};

export type WorkId = string & { readonly __brand: "WorkId" };
export type SourceId = string & { readonly __brand: "SourceId" };
export type PassageId = string & { readonly __brand: "PassageId" };
export type ReleaseHash = Sha256Hex;
export type DateYmd = string & { readonly __brand: "DateYmd" };
export type SafeQueryString = string & { readonly __brand: "SafeQueryString" };

export type HelpCommand = "top" | "search" | "read" | "sources" | "status" | "schema";
export type MatchMode = "any" | "all";
export type SourceRole = "transcript" | "qa" | "summary" | "document";

export type ToolErrorCode =
	| "INVALID_REQUEST"
	| "UNKNOWN_CORPUS_ID"
	| "TOOL_BUDGET_EXHAUSTED"
	| "CORPUS_INTEGRITY_ERROR"
	| "NATIVE_EXEC_ERROR"
	| "OUTPUT_OVERFLOW"
	| "TIMEOUT";

export type ClecRequest =
	| {
			readonly kind: "schema";
			readonly maxBytes?: number;
	  }
	| {
			readonly kind: "help";
			readonly command: HelpCommand;
			readonly maxBytes?: number;
	  }
	| {
			readonly kind: "status";
			readonly maxBytes?: number;
	  }
	| {
			readonly kind: "search";
			readonly queries: readonly SafeQueryString[];
			readonly matchMode?: MatchMode;
			readonly limit?: number;
			readonly perWork?: number;
			readonly workId?: WorkId;
			readonly sourceId?: SourceId;
			readonly role?: SourceRole;
			readonly dateFrom?: DateYmd;
			readonly dateTo?: DateYmd;
			readonly maxBytes?: number;
	  }
	| {
			readonly kind: "read"; readonly original: false;
			readonly ids: readonly PassageId[];
			readonly context?: number;
			readonly find?: SafeQueryString;
			readonly maxBytes?: number;
	  }
	| {
			readonly kind: "read"; readonly original: true;
			readonly ids: readonly SourceId[];
			readonly find?: SafeQueryString;
			readonly maxBytes?: number;
	  }
	| {
			readonly kind: "sources";
			readonly query?: SafeQueryString;
			readonly workId?: WorkId;
			readonly role?: SourceRole;
			readonly canonicalOnly?: boolean;
			readonly limit?: number;
			readonly offset?: number;
			readonly maxBytes?: number;
	  };

export type ParseRequestResult =
	| { readonly ok: true; readonly request: ClecRequest }
	| { readonly ok: false; readonly code: ToolErrorCode; readonly message: string };

export interface PublicCorpusIndex {
	readonly release: ReleaseHash;
	readonly workIds: ReadonlySet<WorkId>;
	readonly sourceIds: ReadonlySet<SourceId>;
	readonly passageIds: ReadonlySet<PassageId>;
}

const WORK_ID_RE = /^w_[0-9a-f]{16,64}$/;
const SOURCE_ID_RE = /^s_[0-9a-f]{16,64}$/;
const PASSAGE_ID_RE = /^p_[0-9a-f]{16,64}$/;
const DATE_YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const HELP_COMMANDS = new Set<string>([
	"top",
	"search",
	"read",
	"sources",
	"status",
	"schema",
]);

const MATCH_MODES = new Set<string>(["any", "all"]);

const SOURCE_ROLES = new Set<string>([
	"transcript",
	"qa",
	"summary",
	"document",
]);

function isHelpCommand(value: unknown): value is HelpCommand {
	return typeof value === "string" && HELP_COMMANDS.has(value);
}

function isMatchMode(value: unknown): value is MatchMode {
	return typeof value === "string" && MATCH_MODES.has(value);
}

function isSourceRole(value: unknown): value is SourceRole {
	return typeof value === "string" && SOURCE_ROLES.has(value);
}

const ALLOWED_KEYS_BY_ACTION: Readonly<Record<ClecRequest["kind"], ReadonlySet<string>>> = {
	schema: new Set(["action", "maxBytes"]),
	help: new Set(["action", "command", "maxBytes"]),
	status: new Set(["action", "maxBytes"]),
	search: new Set([
		"action",
		"queries",
		"matchMode",
		"limit",
		"perWork",
		"workId",
		"sourceId",
		"role",
		"dateFrom",
		"dateTo",
		"maxBytes",
	]),
	read: new Set(["action", "ids", "context", "original", "find", "maxBytes"]),
	sources: new Set([
		"action",
		"query",
		"workId",
		"role",
		"canonicalOnly",
		"limit",
		"offset",
		"maxBytes",
	]),
};

export function isWorkId(value: unknown): value is WorkId {
	return typeof value === "string" && WORK_ID_RE.test(value);
}

export function isSourceId(value: unknown): value is SourceId {
	return typeof value === "string" && SOURCE_ID_RE.test(value);
}

export function isPassageId(value: unknown): value is PassageId {
	return typeof value === "string" && PASSAGE_ID_RE.test(value);
}

export function isReleaseHash(value: unknown): value is ReleaseHash {
	return isSha256Hex(value);
}

export function isDateYmd(value: unknown): value is DateYmd {
	if (typeof value !== "string") return false;
	const match = DATE_YMD_RE.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return false;
	const dt = new Date(0);
	dt.setUTCFullYear(year, month - 1, day);
	return (
		dt.getUTCFullYear() === year &&
		dt.getUTCMonth() === month - 1 &&
		dt.getUTCDate() === day
	);
}

export function isSafeQueryString(value: unknown): value is SafeQueryString {
	if (typeof value !== "string" || value.trim().length === 0) return false;
	if (value.includes("\u0000") || !value.isWellFormed()) return false;
	if (value.startsWith("-") || value.trimStart().startsWith("-")) return false;
	const byteLength = Buffer.byteLength(value, "utf8");
	return byteLength >= 1 && byteLength <= LIMITS.maxQueryUtf8Bytes;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function isBoundedInt(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function reject(code: ToolErrorCode, message: string): ParseRequestResult {
	return { ok: false, code, message };
}

function parseMaxBytes(raw: Record<string, unknown>): { ok: true; value?: number } | { ok: false; err: ParseRequestResult } {
	if (raw.maxBytes === undefined) return { ok: true, value: undefined };
	if (!isBoundedInt(raw.maxBytes, 1, LIMITS.maxStdoutBytesPerCall)) {
		return {
			ok: false,
			err: reject(
				"INVALID_REQUEST",
				`maxBytes must be an integer between 1 and ${LIMITS.maxStdoutBytesPerCall}.`,
			),
		};
	}
	return { ok: true, value: raw.maxBytes };
}

function checkAllowedKeys(
	raw: Record<string, unknown>,
	action: ClecRequest["kind"],
): ParseRequestResult | undefined {
	const allowed = ALLOWED_KEYS_BY_ACTION[action];
	for (const key of Object.keys(raw)) {
		if (!allowed.has(key)) {
			return reject("INVALID_REQUEST", `Unsupported parameter for action "${action}".`);
		}
	}
	return undefined;
}

export function parseRequest(raw: unknown, corpusIndex: PublicCorpusIndex): ParseRequestResult {
	if (!isPlainRecord(raw)) {
		return reject("INVALID_REQUEST", "Request arguments must be a plain JSON object.");
	}
	const action = raw.action;
	if (
		action !== "schema" &&
		action !== "help" &&
		action !== "status" &&
		action !== "search" &&
		action !== "read" &&
		action !== "sources"
	) {
		return reject("INVALID_REQUEST", "action must be one of: schema, help, status, search, read, sources.");
	}

	const keyViolation = checkAllowedKeys(raw, action);
	if (keyViolation) return keyViolation;

	const maxBytesParsed = parseMaxBytes(raw);
	if (!maxBytesParsed.ok) return maxBytesParsed.err;
	const maxBytes = maxBytesParsed.value;

	switch (action) {
		case "schema":
			return { ok: true, request: { kind: "schema", ...(maxBytes !== undefined ? { maxBytes } : {}) } };

		case "status":
			return { ok: true, request: { kind: "status", ...(maxBytes !== undefined ? { maxBytes } : {}) } };

		case "help": {
			if (!isHelpCommand(raw.command)) {
				return reject(
					"INVALID_REQUEST",
					"help command must be one of: top, search, read, sources, status, schema.",
				);
			}
			const command = raw.command;
			return {
				ok: true,
				request: { kind: "help", command, ...(maxBytes !== undefined ? { maxBytes } : {}) },
			};
		}

		case "search": {
			if (
				!Array.isArray(raw.queries) ||
				raw.queries.length < 1 ||
				raw.queries.length > LIMITS.maxQueriesPerSearch
			) {
				return reject(
					"INVALID_REQUEST",
					`search queries must be an array of 1..${LIMITS.maxQueriesPerSearch} strings.`,
				);
			}
			const queries: SafeQueryString[] = [];
			for (const q of raw.queries) {
				if (!isSafeQueryString(q)) {
					return reject(
						"INVALID_REQUEST",
						`Each search query must be 1..${LIMITS.maxQueryUtf8Bytes} UTF-8 bytes without NUL, surrogates, or leading '-'.`,
					);
				}
				queries.push(q);
			}
			if (raw.matchMode !== undefined && !isMatchMode(raw.matchMode)) {
				return reject("INVALID_REQUEST", "matchMode must be 'any' or 'all'.");
			}
			if (raw.limit !== undefined && !isBoundedInt(raw.limit, 1, LIMITS.maxSearchLimit)) {
				return reject("INVALID_REQUEST", `limit must be an integer 1..${LIMITS.maxSearchLimit}.`);
			}
			if (raw.perWork !== undefined && !isBoundedInt(raw.perWork, 1, LIMITS.maxSearchPerWork)) {
				return reject("INVALID_REQUEST", `perWork must be an integer 1..${LIMITS.maxSearchPerWork}.`);
			}
			if (raw.workId !== undefined) {
				if (!isWorkId(raw.workId)) {
					return reject("INVALID_REQUEST", "workId must be a valid w_<hex> identifier.");
				}
				if (!corpusIndex.workIds.has(raw.workId)) {
					return reject("UNKNOWN_CORPUS_ID", "Requested workId is not in the pinned corpus release.");
				}
			}
			if (raw.sourceId !== undefined) {
				if (!isSourceId(raw.sourceId)) {
					return reject("INVALID_REQUEST", "sourceId must be a valid s_<hex> identifier.");
				}
				if (!corpusIndex.sourceIds.has(raw.sourceId)) {
					return reject("UNKNOWN_CORPUS_ID", "Requested sourceId is not in the pinned corpus release.");
				}
			}
			if (raw.role !== undefined && !isSourceRole(raw.role)) {
				return reject("INVALID_REQUEST", "role must be one of: transcript, qa, summary, document.");
			}
			if (raw.dateFrom !== undefined && !isDateYmd(raw.dateFrom)) {
				return reject("INVALID_REQUEST", "dateFrom must be a valid calendar date YYYY-MM-DD.");
			}
			if (raw.dateTo !== undefined && !isDateYmd(raw.dateTo)) {
				return reject("INVALID_REQUEST", "dateTo must be a valid calendar date YYYY-MM-DD.");
			}
			if (raw.dateFrom !== undefined && raw.dateTo !== undefined && raw.dateFrom > raw.dateTo) {
				return reject("INVALID_REQUEST", "dateFrom must be less than or equal to dateTo.");
			}
			return {
				ok: true,
				request: {
					kind: "search",
					queries,
					...(raw.matchMode !== undefined ? { matchMode: raw.matchMode } : {}),
					...(raw.limit !== undefined ? { limit: raw.limit } : {}),
					...(raw.perWork !== undefined ? { perWork: raw.perWork } : {}),
					...(raw.workId !== undefined ? { workId: raw.workId } : {}),
					...(raw.sourceId !== undefined ? { sourceId: raw.sourceId } : {}),
					...(raw.role !== undefined ? { role: raw.role } : {}),
					...(raw.dateFrom !== undefined ? { dateFrom: raw.dateFrom } : {}),
					...(raw.dateTo !== undefined ? { dateTo: raw.dateTo } : {}),
					...(maxBytes !== undefined ? { maxBytes } : {}),
				},
			};
		}

		case "read": {
			if (!Array.isArray(raw.ids) || raw.ids.length < 1 || raw.ids.length > LIMITS.maxReadIds) {
				return reject("INVALID_REQUEST", `read ids must be an array of 1..${LIMITS.maxReadIds} typed IDs.`);
			}
			if (raw.context !== undefined && !isBoundedInt(raw.context, 0, LIMITS.maxReadContext)) {
				return reject("INVALID_REQUEST", `context must be an integer 0..${LIMITS.maxReadContext}.`);
			}
			if (raw.original !== undefined && typeof raw.original !== "boolean") {
				return reject("INVALID_REQUEST", "original must be a boolean.");
			}
			if (raw.find !== undefined && !isSafeQueryString(raw.find)) {
				return reject(
					"INVALID_REQUEST",
					`find must be 1..${LIMITS.maxQueryUtf8Bytes} UTF-8 bytes without NUL, surrogates, or leading '-'.`,
				);
			}
			const options = {
				...(raw.find !== undefined ? { find: raw.find } : {}),
				...(maxBytes !== undefined ? { maxBytes } : {}),
			};
			if (raw.original === true) {
				if (raw.context !== undefined) return reject("INVALID_REQUEST", "Original reads do not accept context.");
				const ids: SourceId[] = [];
				for (const id of raw.ids) {
					if (!isSourceId(id)) return reject("INVALID_REQUEST", "Original reads require SourceId (s_...) references.");
					ids.push(id);
				}
				if (!ids.every(id => corpusIndex.sourceIds.has(id))) {
					return reject("UNKNOWN_CORPUS_ID", "Requested sourceId is not in the pinned corpus release.");
				}
				return { ok: true, request: { kind: "read", original: true, ids, ...options } };
			}
			const ids: PassageId[] = [];
			for (const id of raw.ids) {
				if (!isPassageId(id)) return reject("INVALID_REQUEST", "Passage reads require PassageId (p_...) references.");
				ids.push(id);
			}
			if (!ids.every(id => corpusIndex.passageIds.has(id))) {
				return reject("UNKNOWN_CORPUS_ID", "Requested passageId is not in the pinned corpus release.");
			}
			return { ok: true, request: {
				kind: "read", original: false, ids, ...options,
				...(raw.context !== undefined ? { context: raw.context } : {}),
			} };
		}

		case "sources": {
			if (raw.query !== undefined && !isSafeQueryString(raw.query)) {
				return reject(
					"INVALID_REQUEST",
					`sources query must be 1..${LIMITS.maxQueryUtf8Bytes} UTF-8 bytes without NUL, surrogates, or leading '-'.`,
				);
			}
			if (raw.workId !== undefined) {
				if (!isWorkId(raw.workId)) {
					return reject("INVALID_REQUEST", "workId must be a valid w_<hex> identifier.");
				}
				if (!corpusIndex.workIds.has(raw.workId)) {
					return reject("UNKNOWN_CORPUS_ID", "Requested workId is not in the pinned corpus release.");
				}
			}
			if (raw.role !== undefined && !isSourceRole(raw.role)) {
				return reject("INVALID_REQUEST", "role must be one of: transcript, qa, summary, document.");
			}
			if (raw.canonicalOnly !== undefined && typeof raw.canonicalOnly !== "boolean") {
				return reject("INVALID_REQUEST", "canonicalOnly must be a boolean.");
			}
			if (raw.limit !== undefined && !isBoundedInt(raw.limit, 1, LIMITS.maxSourcesLimit)) {
				return reject("INVALID_REQUEST", `limit must be an integer 1..${LIMITS.maxSourcesLimit}.`);
			}
			if (raw.offset !== undefined && !isBoundedInt(raw.offset, 0, LIMITS.maxSourcesOffset)) {
				return reject("INVALID_REQUEST", `offset must be an integer 0..${LIMITS.maxSourcesOffset}.`);
			}
			return {
				ok: true,
				request: {
					kind: "sources",
					...(raw.query !== undefined ? { query: raw.query } : {}),
					...(raw.workId !== undefined ? { workId: raw.workId } : {}),
					...(raw.role !== undefined ? { role: raw.role } : {}),
					...(raw.canonicalOnly !== undefined ? { canonicalOnly: raw.canonicalOnly } : {}),
					...(raw.limit !== undefined ? { limit: raw.limit } : {}),
					...(raw.offset !== undefined ? { offset: raw.offset } : {}),
					...(maxBytes !== undefined ? { maxBytes } : {}),
				},
			};
		}
	}
}

export const CLEC_TOOL_DESCRIPTION = "Query the pinned public CLEC corpus offline.";

export const CLEC_TOOL_PARAMETERS_SCHEMA = Object.freeze({
	type: "object",
	additionalProperties: false,
	required: ["action"],
	properties: {
		action: {
			type: "string",
			enum: ["schema", "help", "status", "search", "read", "sources"],
			description: "CLEC operation to execute.",
		},
		command: {
			type: "string",
			enum: ["top", "search", "read", "sources", "status", "schema"],
			description: "Target command for action='help'.",
		},
		queries: {
			type: "array",
			items: { type: "string", minLength: 1, maxLength: LIMITS.maxQueryUtf8Bytes },
			minItems: 1,
			maxItems: LIMITS.maxQueriesPerSearch,
			description: "1 to 4 lexical query strings for action='search'.",
		},
		matchMode: {
			type: "string",
			enum: ["any", "all"],
			description: "Token matching mode within each search query.",
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: LIMITS.maxSourcesLimit,
			description: "Result limit: 1..5 for search, 1..100 for sources.",
		},
		perWork: {
			type: "integer",
			minimum: 1,
			maximum: LIMITS.maxSearchPerWork,
			description: "Preferred per-work diversity cap (1..5) for search.",
		},
		workId: {
			type: "string",
			pattern: "^w_[0-9a-f]{16,64}$",
			description: "WorkId filter (w_...) for search or sources.",
		},
		sourceId: {
			type: "string",
			pattern: "^s_[0-9a-f]{16,64}$",
			description: "SourceId filter (s_...) for search.",
		},
		role: {
			type: "string",
			enum: ["transcript", "qa", "summary", "document"],
			description: "Source role filter for search or sources.",
		},
		dateFrom: {
			type: "string",
			pattern: "^\\d{4}-\\d{2}-\\d{2}$",
			description: "Inclusive YYYY-MM-DD start date filter for search.",
		},
		dateTo: {
			type: "string",
			pattern: "^\\d{4}-\\d{2}-\\d{2}$",
			description: "Inclusive YYYY-MM-DD end date filter for search.",
		},
		ids: {
			type: "array",
			items: { type: "string", pattern: "^[ps]_[0-9a-f]{16,64}$" },
			minItems: 1,
			maxItems: LIMITS.maxReadIds,
			description: "1 to 50 typed PassageId (p_...) or SourceId (s_...) values for action='read'.",
		},
		context: {
			type: "integer",
			minimum: 0,
			maximum: LIMITS.maxReadContext,
			description: "Adjacent passages per side (0..2) for PassageId reads.",
		},
		original: {
			type: "boolean",
			description: "Use true with only SourceIds and no context. Otherwise use only PassageIds.",
		},
		find: {
			type: "string",
			minLength: 1,
			maxLength: LIMITS.maxQueryUtf8Bytes,
			description: "Literal substring search inside read target.",
		},
		query: {
			type: "string",
			minLength: 1,
			maxLength: LIMITS.maxQueryUtf8Bytes,
			description: "Optional literal filter for action='sources'.",
		},
		canonicalOnly: {
			type: "boolean",
			description: "Return only canonical sources for action='sources'.",
		},
		offset: {
			type: "integer",
			minimum: 0,
			maximum: LIMITS.maxSourcesOffset,
			description: "Zero-based pagination offset for action='sources'.",
		},
		maxBytes: {
			type: "integer",
			minimum: 1,
			maximum: LIMITS.maxStdoutBytesPerCall,
			description: "Optional stdout byte cap (1..32768).",
		},
	},
} as const);

const KNOWN_CLEC_ERROR_CODES: ReadonlySet<string> = new Set([
	"INVALID_ARGUMENT",
	"INVALID_QUERY",
	"INVALID_REFERENCE",
	"UNSUPPORTED_FEATURE",
	"OFFLINE_REQUIRED",
	"OUTPUT_BUDGET_TOO_SMALL",
	"INVALID_JEV_CONFIG",
	"SAG2_BUDGET_EXHAUSTED",
	"NO_DATA",
	"VERSION_UNAVAILABLE",
	"EVIDENCE_NOT_FOUND",
	"SYNC_LOCKED",
	"INVALID_DATA_DIR",
	"TRANSFER_FAILED",
	"TRANSFER_TIMEOUT",
	"JEV_HTTP_STATUS",
	"IO_ERROR",
	"INVALID_PACKAGE",
	"INTEGRITY_MISMATCH",
	"JEV_INVALID_RESPONSE",
	"INVALID_MANIFEST",
	"EMPTY_CORPUS",
	"OUTPUT_EXISTS",
	"UNSAFE_PATH",
	"INTERNAL_ERROR",
]);

export function fixedInvocation(request: ClecRequest, pins: {
	readonly nativePath: string; readonly dataDir: string; readonly release: ReleaseHash;
}) {
	return { execPath: pins.nativePath, argv: fixedArgv(request, pins) };
}

function fixedArgv(request: ClecRequest, pins: { dataDir: string; release: ReleaseHash }): readonly string[] {
	const maxBytes = request.maxBytes ?? HOST_LIMITS.nativeStdoutBytes;
	const baseGlobals = ["--offline", "--json", "--max-bytes", String(maxBytes)];
	const storeGlobals = ["--data-dir", pins.dataDir, ...baseGlobals];

	switch (request.kind) {
		case "schema":
			return [...baseGlobals, "schema"];
		case "help":
			return request.command === "top"
				? [...baseGlobals, "--help"]
				: [...baseGlobals, request.command, "--help"];
		case "status":
			return [...storeGlobals, "status"];
		case "search": {
			const args = [...storeGlobals, "search", `--release=${pins.release}`];
			if (request.matchMode !== undefined) args.push(`--match-mode=${request.matchMode}`);
			if (request.limit !== undefined) args.push(`--limit=${request.limit}`);
			if (request.perWork !== undefined) args.push(`--per-work=${request.perWork}`);
			if (request.workId !== undefined) args.push(`--work=${request.workId}`);
			if (request.sourceId !== undefined) args.push(`--source=${request.sourceId}`);
			if (request.role !== undefined) args.push(`--role=${request.role}`);
			if (request.dateFrom !== undefined) args.push(`--date-from=${request.dateFrom}`);
			if (request.dateTo !== undefined) args.push(`--date-to=${request.dateTo}`);
			args.push("--", ...request.queries);
			return args;
		}
		case "read": {
			const args = [...storeGlobals, "read"];
			if (!request.original && request.context !== undefined) args.push(`--context=${request.context}`);
			if (request.original === true) args.push("--original");
			if (request.find !== undefined) args.push(`--find=${request.find}`);
			args.push("--", ...request.ids);
			return args;
		}
		case "sources": {
			const args = [...storeGlobals, "sources"];
			if (request.workId !== undefined) args.push(`--work=${request.workId}`);
			if (request.role !== undefined) args.push(`--role=${request.role}`);
			if (request.canonicalOnly === true) args.push("--canonical-only");
			if (request.limit !== undefined) args.push(`--limit=${request.limit}`);
			if (request.offset !== undefined) args.push(`--offset=${request.offset}`);
			if (request.query !== undefined) args.push("--", request.query);
			return args;
		}
	}
}

function extractErrorCodeFromStderr(raw: string): string | undefined {
	if (!raw) return undefined;
	for (const line of raw.split("\n")) {
		try {
			const parsed = JSON.parse(line) as { error?: { code?: unknown } };
			const code = parsed?.error?.code;
			if (typeof code === "string" && KNOWN_CLEC_ERROR_CODES.has(code)) {
				return code;
			}
		} catch {
			// Ignore non-JSON stderr lines.
		}
	}
	return undefined;
}

export function nativeErrorText(exitCode: number | null, stderr: string): string {
	const code = extractErrorCodeFromStderr(stderr) ?? "NATIVE_EXEC_ERROR";
	return `NATIVE_EXEC_ERROR: CLEC_ERROR:${code} (exit ${exitCode})`;
}

export function requestRejection(result: Extract<ParseRequestResult, { ok: false }>): string {
	return `${result.code}: ${result.message}`;
}
