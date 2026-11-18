import type { DrainResult, AttemptJournalRecord } from "../capture/framing.ts";
import type { GroupState, ProcessObservation, SignalEvidence } from "../capture/process-group.ts";
import type { AttemptId, GroupLeaseId, RunId, Sha256Hex, HOST_LIMITS } from "../contract/types.ts";

export type AttemptStatus =
	| "Answered"
	| "TaskFailed"
	| "PreWorkInfrastructureFailed"
	| "DeniedAndTerminated"
	| "InvalidEvidence";

export interface FaultControls {
	readonly adapterPathOverride?: string;
	readonly helperPathOverride?: string;
	readonly nativeExecOverride?: string;
	readonly nativeArgsOverride?: readonly string[];
	readonly nativeSentinelPath?: string;
	readonly bypassReadyCheck?: boolean;
	readonly alterPromptEncoder?: (question: string) => string;
	readonly injectJournalFailOnKind?: AttemptJournalRecord["kind"];
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

export interface AttemptInput {
	readonly caseLabel: string;
	readonly evidenceParentDir: string;
	readonly question: string;
	readonly mockBaseUrl: string;
	readonly modelId?: string;
	readonly providerId?: string;
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
}

export interface AttemptReport {
	readonly certificateNotice: typeof HOST_LIMITS.certificateNotice;
	readonly toolProfile: typeof HOST_LIMITS.toolProfile;
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
		readonly stop: SignalEvidence | null;
		readonly closure: ProcessObservation | null;
	}>;
	readonly answerText: string | null;
	readonly piPid?: number | null;
	readonly piExitCode: number | null;
	readonly piSignal: string | null;
	readonly piStop?: SignalEvidence;
	readonly captureDrain?: DrainResult;
	readonly finalCapture?: {
		readonly closedAtMonotonicMs: number;
		readonly journalSeq: number;
		readonly journalBytes: number;
	};
	readonly uncertified: boolean;
	readonly rawArtifacts: {
		readonly journalPath: string;
		readonly piStdoutPath: string | null;
		readonly piStderrPath: string | null;
	};
	readonly closureBeforeSha256: Sha256Hex;
	readonly closureAfterSha256: Sha256Hex | null;
}
