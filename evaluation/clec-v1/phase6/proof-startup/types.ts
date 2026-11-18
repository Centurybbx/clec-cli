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

export const UNIT1_LIMITS = {
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
	promptPrefix: "CLEC public question follows.\n",
	startupTimeoutMs: 15_000,
	toolProfile: "unit1-narrow-status-only",
	certificateNotice: "PROOF_ONLY_NOT_A_COMPLETE_RUN_CERTIFICATE",
} as const;

export type GroupState =
	| "Reserved"
	| "WaitingForRegistration"
	| "Stopping"
	| "RegisteredWaiting"
	| "Released"
	| "Closed"
	| "Unknown";

export type ProcessObservation =
	| {
			readonly kind: "gone";
			readonly pgid: number;
			readonly checkedAtMonotonicMs: number;
			readonly pidsChecked: readonly number[];
	  }
	| {
			readonly kind: "alive";
			readonly pgid: number;
			readonly checkedAtMonotonicMs: number;
			readonly survivors: ReadonlyArray<{
				readonly pid: number;
				readonly ppid: number;
				readonly pgid: number;
				readonly lstart: string;
				readonly command: string;
			}>;
	  }
	| {
			readonly kind: "unknown";
			readonly pgid: number;
			readonly checkedAtMonotonicMs: number;
			readonly reason: string;
	  };

export type PipeChildToOuter =
	| {
			readonly kind: "bound_ready";
			readonly seq: number;
			readonly activeTools: readonly string[];
			readonly allTools: ReadonlyArray<{
				readonly name: string;
				readonly exposure: string;
				readonly parameters: unknown;
			}>;
			readonly deferredTools: readonly string[];
			readonly model: { readonly provider: string; readonly id: string } | null;
			readonly thinkingLevel: string | null;
			readonly adapterSha256?: string;
	  }
	| {
			readonly kind: "provider_candidate";
			readonly seq: number;
			readonly watermark: number;
			readonly payloadDigest: Sha256Hex;
			readonly payloadByteLength: number;
			readonly payloadJson: string;
	  }
	| {
			readonly kind: "tool_start_observe";
			readonly seq: number;
			readonly callId: string;
			readonly toolName: string;
			readonly args: unknown;
	  }
	| {
			readonly kind: "tool_execute";
			readonly seq: number;
			readonly callId: string;
			readonly toolName: string;
			readonly params: unknown;
	  }
	| {
			readonly kind: "adapter_fault_note";
			readonly stage: string;
			readonly detail: string;
	  };

export type PipeOuterToChild =
	| {
			readonly kind: "bound_ready_ack";
			readonly seq: number;
			readonly attemptId: AttemptId;
	  }
	| {
			readonly kind: "provider_permit";
			readonly seq: number;
			readonly attemptId: AttemptId;
			readonly watermark: number;
			readonly payloadDigest: Sha256Hex;
	  }
	| {
			readonly kind: "tool_start_ack";
			readonly seq: number;
			readonly callId: string;
			readonly allowed: boolean;
			readonly ordinal?: number;
			readonly reason?: string;
	  }
	| {
			readonly kind: "tool_result";
			readonly seq: number;
			readonly callId: string;
			readonly isError: boolean;
			readonly text: string;
	  };

export type HelperChildToOuter =
	| {
			readonly kind: "helper_ready";
			readonly leaseId: GroupLeaseId;
			readonly pid: number;
			readonly pgid: number;
			readonly lstart: string | null;
	  }
	| {
			readonly kind: "native_started";
			readonly leaseId: GroupLeaseId;
			readonly pid: number;
			readonly pgid: number;
			readonly lstart: string | null;
	  }
	| {
			readonly kind: "native_chunk";
			readonly leaseId: GroupLeaseId;
			readonly stream: "stdout" | "stderr";
			readonly dataBase64: string;
	  }
	| {
			readonly kind: "native_exited";
			readonly leaseId: GroupLeaseId;
			readonly exitCode: number | null;
			readonly signal: string | null;
	  }
	| {
			readonly kind: "helper_error";
			readonly leaseId: GroupLeaseId;
			readonly message: string;
	  };

export type HelperOuterToChild = {
	readonly kind: "go";
	readonly leaseId: GroupLeaseId;
	readonly execPath: string;
	readonly argv: readonly string[];
	readonly cwd: string;
};

export interface ProofJournalRecord {
	readonly seq: number;
	readonly monotonicMs: number;
	readonly utcIso: string;
	readonly runId: RunId;
	readonly attemptId: AttemptId;
	readonly kind:
		| "plan_committed"
		| "closure_verified"
		| "pi_spawned"
		| "bound_ready"
		| "bound_ready_ack"
		| "get_state_ok"
		| "prompt_encoded"
		| "prompt_sent"
		| "prompt_preflight"
		| "provider_candidate"
		| "provider_grant"
		| "provider_denied"
		| "provider_permit_sent"
		| "tool_declared_batch"
		| "tool_start_reserved"
		| "tool_start_denied"
		| "group_reserved"
		| "group_registered"
		| "group_go_sent"
		| "native_pid_reported"
		| "native_exited"
		| "tool_result_delivered"
		| "agent_settled"
		| "pi_exited"
		| "group_closure_observed"
		| "overflow_uncertified"
		| "journal_fault"
		| "attempt_closed";
	readonly body: Record<string, unknown>;
}

export type AttemptStatus =
	| "Answered"
	| "TaskFailed"
	| "PreWorkInfrastructureFailed"
	| "DeniedAndTerminated"
	| "InvalidEvidence";

export interface Unit1FaultHooks {
	readonly adapterPathOverride?: string;
	readonly helperPathOverride?: string;
	readonly nativeExecOverride?: string;
	readonly nativeArgsOverride?: readonly string[];
	readonly nativeSentinelPath?: string;
	readonly bypassReadyCheck?: boolean;
	readonly alterPromptEncoder?: (question: string) => string;
	readonly injectJournalFailOnKind?: ProofJournalRecord["kind"];
	readonly injectJournalFailAfterGrant?: boolean;
	readonly injectMalformedPermitAck?: boolean;
	readonly injectReplayedPermitAck?: boolean;
	readonly injectKillPiBeforeReady?: boolean;
	readonly injectKillPiBetweenRegAndGo?: boolean;
	readonly injectKillPiDuringNativeOutput?: boolean;
	readonly injectOmitNativeTeardown?: boolean;
	readonly injectSkipGoAndCloseHelper?: boolean;
	readonly injectPsFailure?: boolean;
	readonly precreateAgentDirFile?: {
		readonly relativePath: "APPEND_SYSTEM.md" | "SYSTEM.md" | "settings.json" | "models.json";
		readonly content: string;
	};
	readonly duplicateAttemptIdCollision?: AttemptId;
	readonly simulatedSinkStallMs?: number;
	readonly startupTimeoutMsOverride?: number;
	readonly caseDeadlineMsOverride?: number;
	readonly nativeDeadlineMsOverride?: number;
}

export interface Unit1RunRequest {
	readonly caseLabel: string;
	readonly evidenceParentDir: string;
	readonly question: string;
	readonly mockBaseUrl: string;
	readonly modelId?: string;
	readonly providerId?: string;
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
	readonly faults?: Unit1FaultHooks;
}

export interface ProofRunResult {
	readonly certificateNotice: typeof UNIT1_LIMITS.certificateNotice;
	readonly toolProfile: typeof UNIT1_LIMITS.toolProfile;
	readonly runId: RunId;
	readonly attemptId: AttemptId;
	readonly bundleDir: string;
	readonly indexEntryPath: string;
	readonly indexPublicationError?: string;
	readonly status: AttemptStatus;
	readonly failureReason: string | null;
	readonly promptReceived: boolean;
	readonly originalQuestionBytesSha256: Sha256Hex | null;
	readonly encodedPromptBytesSha256: Sha256Hex | null;
	readonly encodedPromptText: string | null;
	readonly providerRequestsGranted: number;
	readonly providerRequestsDenied: number;
	readonly declaredToolCalls: ReadonlyArray<{
		readonly id: string;
		readonly name: string;
		readonly ordinal: number | null;
	}>;
	readonly nativeStarts: number;
	readonly groupObservations: ReadonlyArray<{
		readonly leaseId: GroupLeaseId;
		readonly state: GroupState;
		readonly pgid: number | null;
		readonly helperPid: number | null;
		readonly nativePid: number | null;
		readonly registeredBeforeGo: boolean;
		readonly sentinelAbsentAtRegistration: boolean | null;
		readonly killEscalationMs: number | null;
		readonly stop: import("./process-group.ts").SignalEvidence | null;
		readonly closure: ProcessObservation | null;
	}>;
	readonly answerText: string | null;
	readonly piPid?: number | null;
	readonly piExitCode: number | null;
	readonly piSignal: string | null;
	readonly piStop?: import("./process-group.ts").SignalEvidence;
	readonly captureDrain?: import("./framing.ts").DrainResult;
	readonly uncertified: boolean;
	readonly rawArtifacts: {
		readonly journalPath: string;
		readonly piStdoutPath: string;
		readonly piStderrPath: string;
	};
	readonly closureBeforeSha256: Sha256Hex;
	readonly closureAfterSha256: Sha256Hex | null;
}
