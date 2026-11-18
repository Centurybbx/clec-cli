export type Sha256Hex = string & { readonly __brand: "Sha256Hex" };
export type RunId = string & { readonly __brand: "RunId" };
export type AttemptId = string & { readonly __brand: "AttemptId" };
export type CallId = string & { readonly __brand: "CallId" };
export type GroupLeaseId = string & { readonly __brand: "GroupLeaseId" };

export function isSha256Hex(value: unknown): value is Sha256Hex {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function asSha256Hex(value: string, label: string): Sha256Hex {
	if (!isSha256Hex(value)) {
		throw new Error(`Invalid SHA-256 hex for ${label}: ${value}`);
	}
	return value;
}

export function isSafeTokenId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

export function makeRunId(value: string): RunId {
	if (!isSafeTokenId(value)) {
		throw new Error(`Invalid RunId: ${value}`);
	}
	return value as RunId;
}

export function makeAttemptId(value: string): AttemptId {
	if (!isSafeTokenId(value)) {
		throw new Error(`Invalid AttemptId: ${value}`);
	}
	return value as AttemptId;
}

export function makeCallId(value: string): CallId {
	if (typeof value !== "string" || value.length === 0 || value.length > 256) {
		throw new Error(`Invalid CallId: ${String(value)}`);
	}
	return value as CallId;
}

export function makeGroupLeaseId(value: string): GroupLeaseId {
	if (!isSafeTokenId(value)) {
		throw new Error(`Invalid GroupLeaseId: ${value}`);
	}
	return value as GroupLeaseId;
}

export const HOST_LIMITS = {
	maxAttempts: 8,
	nativeStdoutBytes: 32_768,
	nativeStderrBytes: 8_192,
	nativeDeadlineMs: 30_000,
	caseDeadlineMs: 180_000,
	answerBytes: 65_536,
	piStdoutBytes: 16 * 1024 * 1024,
	piStderrBytes: 65_536,
	controlFrameBytes: 16 * 1024 * 1024,
	controlAggregateBytes: 64 * 1024 * 1024,
	journalTotalBytes: 64 * 1024 * 1024,
	journalEmergencyReserveBytes: 1024 * 1024,
	killGraceMs: 2_000,
	maxPendingSinkBytes: 65_536,
	maxQueuedPipeChunks: 1024,
	promptPrefix: "CLEC public question follows.\n",
	startupTimeoutMs: 15_000,
	toolProfile: "clec-public-offline-v1",
	certificateNotice: "PROOF_ONLY_NOT_A_COMPLETE_RUN_CERTIFICATE",
} as const;
