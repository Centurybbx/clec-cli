import { spawnSync } from "node:child_process";
import {
	CLEC_TOOL_PARAMETERS_SCHEMA, fixedInvocation, isReleaseHash, nativeErrorText,
	parseRequest, requestRejection,
} from "../../phase6/host/contract/request.ts";
import { HOST_LIMITS } from "../../phase6/host/contract/types.ts";

export const PROFILE = "clec-agent-native-offline-v1";
export const DESCRIPTION = "Search for passage leads and read exact evidence from the pinned CLEC corpus.";
export const PARAMETERS = {
	...CLEC_TOOL_PARAMETERS_SCHEMA,
	properties: {
		...CLEC_TOOL_PARAMETERS_SCHEMA.properties,
		limit: {
			...CLEC_TOOL_PARAMETERS_SCHEMA.properties.limit,
			description: "Search leads 1..50 (default 20), or source results 1..100.",
		},
		offset: {
			...CLEC_TOOL_PARAMETERS_SCHEMA.properties.offset,
			description: "Zero-based pagination offset for search or sources.",
		},
		context: { ...CLEC_TOOL_PARAMETERS_SCHEMA.properties.context, default: 0 },
		release: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Search response release for reads." },
		cues: { type: "boolean", description: "Include subtitle cues on passage reads." },
	},
};

export function requestArgs(input, index, pins) {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_REQUEST");
	const { cues, release, ...legacy } = input;
	if (input.action === "search" && Array.isArray(input.queries)
		&& input.queries.some(query => typeof query === "string" && Buffer.byteLength(query) > 512)) {
		throw new Error("INVALID_REQUEST: search queries must fit 512 UTF-8 bytes");
	}
	if (input.action !== "read" && (cues !== undefined || release !== undefined)) {
		throw new Error("INVALID_REQUEST: cues and release are read parameters");
	}
	if (cues !== undefined && (typeof cues !== "boolean" || input.original === true)) {
		throw new Error("INVALID_REQUEST: cues require passage reads");
	}
	if (release !== undefined && !isReleaseHash(release)) throw new Error("INVALID_REQUEST: invalid release");
	if (release !== undefined && release !== index.release) throw new Error("VERSION_UNAVAILABLE");
	// Delegate ID, query and action validation to the pinned legacy contract.
	const isSearch = legacy.action === "search";
	const searchOffset = isSearch ? legacy.offset : undefined;
	if (searchOffset !== undefined && (!Number.isInteger(searchOffset) || searchOffset < 0 || searchOffset > 1_000_000)) {
		throw new Error("INVALID_REQUEST: search offset must be an integer 0..1000000.");
	}
	const wide = isSearch && Number.isInteger(legacy.limit)
		&& legacy.limit > 5 && legacy.limit <= 50;
	let sanitized = legacy;
	if (isSearch) {
		const { offset: _searchOffset, ...rest } = legacy;
		sanitized = wide ? { ...rest, limit: 5 } : rest;
	}
	const parsed = parseRequest(sanitized, index);
	if (!parsed.ok) throw new Error(requestRejection(parsed));
	const request = wide ? { ...parsed.request, limit: legacy.limit } : parsed.request;
	const { argv } = fixedInvocation(request, pins);
	if (request.kind === "search") {
		if (searchOffset === undefined) return argv;
		const end = argv.indexOf("--");
		return [...argv.slice(0, end), `--offset=${searchOffset}`, ...argv.slice(end)];
	}
	if (request.kind !== "read") return argv;
	const end = argv.indexOf("--");
	return [...argv.slice(0, end), `--release=${pins.release}`, ...(cues ? ["--cues"] : []), ...argv.slice(end)];
}

function boundedError(exitCode, stderr) {
	const summary = nativeErrorText(exitCode, stderr);
	let envelope;
	try { envelope = JSON.parse(stderr); } catch { return summary; }
	if (envelope?.error?.code !== "OUTPUT_BUDGET_TOO_SMALL") return summary;
	const command = envelope.command;
	if (command !== "search" && command !== "read") return summary;
	const requiredBytes = envelope.error.requiredBytes;
	if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 1) return summary;
	const retry = requiredBytes <= HOST_LIMITS.nativeStdoutBytes
		? { maxBytes: requiredBytes }
		: { action: command === "search" ? "reduceSearchLimit" : "readFewerIdsOrReduceContext" };
	return JSON.stringify({ error: { code: "OUTPUT_BUDGET_TOO_SMALL", command, requiredBytes, retry } });
}

export function runTool(input, index, pins) {
	const argv = requestArgs(input, index, pins);
	const result = spawnSync(pins.nativePath, argv, {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 25_000, maxBuffer: 65_536,
		env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
	});
	if (result.error || result.status === null) throw new Error("NATIVE_EXEC_ERROR");
	const cap = Number(argv[argv.indexOf("--max-bytes") + 1]);
	if (result.stdout.length > cap || result.stderr.length > HOST_LIMITS.nativeStderrBytes) {
		throw new Error("OUTPUT_OVERFLOW");
	}
	const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	const stdout = utf8.decode(result.stdout);
	const stderr = utf8.decode(result.stderr);
	if (result.status === 0 && stderr) throw new Error("NATIVE_EXEC_ERROR: unexpected stderr");
	if (result.status !== 0 && stdout) throw new Error("NATIVE_EXEC_ERROR: unexpected stdout");
	return {
		argv, exitCode: result.status, stdout, stderr,
		text: result.status === 0 ? stdout : boundedError(result.status, stderr),
	};
}
