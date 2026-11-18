import type { AttemptJournalRecord } from "../capture/framing.ts";
import type { AttemptStatus, AttemptReport, AttemptInput, FaultControls } from "./attempt-types.ts";
import type { PipeChildToOuter, PipeOuterToChild } from "../clec-tool/protocol.ts";
import { materializeCorpus, verifyAttemptCorpus, type readPublicCorpus } from "../contract/corpus.ts";
import { CLEC_TOOL_PARAMETERS_SCHEMA, fixedInvocation, nativeErrorText, parseRequest, requestRejection, type ClecRequest } from "../contract/request.ts";
import { deepEqualJson, modelsBytes, settingsBytes, systemPrompt, validateProviderPayload, type AttemptIdentity, type ExpectedCommitments } from "../contract.ts";
import type { PiProjection } from "../validate.ts";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
	attachBoundedJsonlReader,
	byDeadline,
	captureRawStream,
	type DrainResult,
	BoundedJournalWriter,
	BoundedRawSink,
	createExclusiveDir,
	scheduleDeadline,
	writeBoundedFrame,
	writeExclusiveFile,
	publishExclusiveIndex,
} from "../capture/framing.ts";
import {
	buildScrubbedChildEnv,
	captureExecutionClosure,
	type ExecutionClosure,
	verifyExecutionClosure,
	sha256Buffer,
	verifyFilePin,
} from "../capture/pins.ts";
import {
	armStop,
	type ArmedStop,
	STOP_GRACE_MS,
	ProcessGroupRegistry,
	readOsProcessTable,
	runRegisteredNativeGroup,
	resolveDefaultHelperPath,
} from "../capture/process-group.ts";
import type {
	AttemptId,
	GroupLeaseId,
	RunId,
	Sha256Hex,
} from "../contract/types.ts";
import { makeAttemptId, makeGroupLeaseId, makeRunId, HOST_LIMITS } from "../contract/types.ts";

function validateAgentDirPreLaunch(agentDir: string, cwd: string): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
	const unexpectedInAgent = readdirSync(agentDir);
	if (unexpectedInAgent.length > 0) {
		return { ok: false, reason: `Unexpected pre-existing agentDir files: ${unexpectedInAgent.join(", ")}` };
	}
	const unexpectedInCwd = readdirSync(cwd);
	if (unexpectedInCwd.length > 0) {
		return { ok: false, reason: `Unexpected pre-existing cwd files: ${unexpectedInCwd.join(", ")}` };
	}
	return { ok: true };
}

export function resolveDefaultAdapterPath(): string {
	return resolve(import.meta.dirname, "../clec-tool.ts");
}

type AttemptEvidence = {
	readonly anchor: ExpectedCommitments;
	readonly identity: AttemptIdentity;
	readonly pi: PiProjection;
	readonly corpus: ReturnType<typeof readPublicCorpus>;
	readonly preamble: string;
};

export async function runAttempt(
	request: AttemptInput,
	options: { readonly cachedClosure?: ExecutionClosure } & (
		| { readonly evidence: AttemptEvidence; readonly faultControls?: never }
		| { readonly evidence?: never; readonly faultControls?: FaultControls }
	),
): Promise<AttemptReport> {
	if (options.evidence && options.faultControls) throw new Error("Fault controls are test-only");
	const closureBefore = options.cachedClosure
		? verifyExecutionClosure(options.cachedClosure)
		: captureExecutionClosure();
	const monotonicStartMs = performance.now();
	const nowMs = (): number => performance.now() - monotonicStartMs;
	const endpoint = new URL(request.mockBaseUrl);
	if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" ||
		!endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
		throw new Error("The host requires a private IPv4 loopback mock endpoint");
	}

	const runId = options?.evidence?.anchor.runId ?? makeRunId(`u1-${Date.now()}-${randomBytes(4).toString("hex")}`);
	const attemptId = options?.evidence?.identity.attemptId ?? options.faultControls?.duplicateAttemptIdCollision ?? makeAttemptId(`${runId}-a1`);

	const helperPin = closureBefore.hostFiles.find((file) => file.logicalPath === resolveDefaultHelperPath());
	if (!helperPin) throw new Error("Missing pinned native helper");

	const bundleDir = join(request.evidenceParentDir, options?.evidence ? attemptId : runId);
	const attemptDir = join(request.evidenceParentDir, "attempts", attemptId);
	const indexDir = join(request.evidenceParentDir, "_index");
	const cwd = join(attemptDir, "cwd");
	const homeDir = join(attemptDir, "home");
	const agentDir = join(attemptDir, "agent");
	const tmpDir = join(attemptDir, "tmp");
	const dataDir = join(attemptDir, "data");
	const captureDir = join(attemptDir, "capture");
	const journalPath = join(captureDir, "journal.jsonl");
	const piStdoutPath = join(captureDir, "pi.stdout.jsonl");
	const piStderrPath = join(captureDir, "pi.stderr.bin");
	const indexEntryPath = join(indexDir, `${options?.evidence ? attemptId : runId}.json`);

	if (!existsSync(request.evidenceParentDir)) {
		createExclusiveDir(request.evidenceParentDir);
	}
	const attemptsParent = join(request.evidenceParentDir, "attempts");
	if (!existsSync(attemptsParent)) {
		createExclusiveDir(attemptsParent);
	}
	if (!existsSync(indexDir)) {
		createExclusiveDir(indexDir);
	}

	createExclusiveDir(bundleDir);
	try {
		createExclusiveDir(attemptDir);
		createExclusiveDir(cwd);
		createExclusiveDir(homeDir);
		createExclusiveDir(agentDir);
		createExclusiveDir(tmpDir);
		createExclusiveDir(dataDir);
		createExclusiveDir(captureDir);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const collisionJournalPath = join(bundleDir, "collision.journal.jsonl");
		const collisionJournal = new BoundedJournalWriter({ path: collisionJournalPath });
		await collisionJournal.append(
			{
				runId,
				attemptId,
				kind: "attempt_closed",
				body: { status: "PreWorkInfrastructureFailed", reason: `Exclusive resource collision: ${msg}` },
			},
			nowMs(),
			"emergency",
		);
		await collisionJournal.close(performance.now() + HOST_LIMITS.killGraceMs);
		return publishAttemptIndex({
			certificateNotice: HOST_LIMITS.certificateNotice,
			toolProfile: HOST_LIMITS.toolProfile,
			runId,
			attemptId,
			bundleDir,
			indexEntryPath,
			status: "PreWorkInfrastructureFailed",
			failureReason: `Exclusive resource collision: ${msg}`,
			promptReceived: false,
			originalQuestionBytesSha256: null,
			encodedPromptBytesSha256: null,
			encodedPromptText: null,
			providerRequestsGranted: 0,
			providerRequestsDenied: 0,
			declaredToolCalls: [],
			nativeStarts: 0,
			groupObservations: [],
			answerText: null,
			piExitCode: null,
			piSignal: null,
			uncertified: true,
			rawArtifacts: { journalPath: collisionJournalPath, piStdoutPath: null, piStderrPath: null },
			closureBeforeSha256: closureBefore.closureDigest,
			closureAfterSha256: null,
		});
	}

	let uncertified = false;
	let overflow: { stream: string; observedBytes: number } | undefined;
	let stopOnIoFailure: ((reason: string) => void) | undefined;
	const ioFailure = (reason: string): void => {
		uncertified = true;
		stopOnIoFailure?.(reason);
	};
	const journal = new BoundedJournalWriter({
		path: journalPath, failNextKind: options.faultControls?.injectJournalFailOnKind,
		onFailure: ioFailure,
	});
	const piSink = (stream: string, path: string, maxBytes: number): BoundedRawSink => new BoundedRawSink({
		path, maxBytes, stallMs: options.faultControls?.simulatedSinkStallMs,
		onOverflow: (bytes) => {
			ioFailure(`${stream} overflow: ${bytes} > ${maxBytes}`);
			overflow = { stream, observedBytes: bytes };
		},
		onWriteFailure: (err) => ioFailure(`${stream}: ${err.message}`),
	});
	const piStdoutSink = piSink("pi_stdout", piStdoutPath, HOST_LIMITS.piStdoutBytes);
	const piStderrSink = piSink("pi_stderr", piStderrPath, HOST_LIMITS.piStderrBytes);

	const providerId = request.providerId ?? "mock-openai";
	const modelId = request.modelId ?? "mock-gpt";
	const thinkingLevel = request.thinkingLevel ?? "off";
	const registry = new ProcessGroupRegistry(monotonicStartMs);

	const originalQuestionSha256 = sha256Buffer(Buffer.from(request.question, "utf8"));
	const encodedPromptText = options.faultControls?.alterPromptEncoder
		? options.faultControls.alterPromptEncoder(request.question)
		: `${HOST_LIMITS.promptPrefix}${request.question}`;
	const encodedPromptSha256 = sha256Buffer(Buffer.from(encodedPromptText, "utf8"));

	let status: AttemptStatus = "PreWorkInfrastructureFailed";
	let failureReason: string | null = null;
	let promptReceived = false;
	let providerRequestsGranted = 0;
	let providerRequestsDenied = 0;
	let nativeStarts = 0;
	let answerText: string | null = null;
	let piExitCode: number | null = null;
	let piSignal: string | null = null;
	const declaredToolCalls: Array<{ id: string; name: string; ordinal: number | null }> = [];
	const seenDeclaredCallIds = new Set<string>();
	const seenStartedCallIds = new Set<string>();
	const reservedCallOrdinals = new Map<string, number>();
	const executableCalls = new Map<string, { ordinal: number; request: ClecRequest }>();
	const corpus = options.evidence?.corpus;
	const corpusPins = corpus && materializeCorpus(dataDir, corpus);
	const checkCorpus = async (): Promise<void> => {
		if (corpusPins) await verifyAttemptCorpus(dataDir, corpusPins);
	};

	if (options.faultControls?.precreateAgentDirFile) {
		writeExclusiveFile(
			join(agentDir, options.faultControls.precreateAgentDirFile.relativePath),
			options.faultControls.precreateAgentDirFile.content,
		);
	}

	const precheck = validateAgentDirPreLaunch(agentDir, cwd);
	if (!precheck.ok) {
		uncertified = true;
		failureReason = precheck.reason;
		await journal.append(
			{ runId, attemptId, kind: "attempt_closed", body: { status, reason: precheck.reason } },
			nowMs(),
			"emergency",
		);
		await piStdoutSink.close(performance.now() + HOST_LIMITS.killGraceMs);
		await piStderrSink.close(performance.now() + HOST_LIMITS.killGraceMs);
		await journal.close(performance.now() + HOST_LIMITS.killGraceMs);
		return publishAttemptIndex({
			certificateNotice: HOST_LIMITS.certificateNotice,
			toolProfile: HOST_LIMITS.toolProfile,
			runId,
			attemptId,
			bundleDir,
			indexEntryPath,
			status,
			failureReason,
			promptReceived: false,
			originalQuestionBytesSha256: originalQuestionSha256,
			encodedPromptBytesSha256: encodedPromptSha256,
			encodedPromptText: null,
			providerRequestsGranted: 0,
			providerRequestsDenied: 0,
			declaredToolCalls: [],
			nativeStarts: 0,
			groupObservations: [],
			answerText: null,
			piExitCode: null,
			piSignal: null,
			uncertified: true,
			rawArtifacts: { journalPath, piStdoutPath, piStderrPath },
			closureBeforeSha256: closureBefore.closureDigest,
			closureAfterSha256: closureBefore.closureDigest,
		});
	}

	writeExclusiveFile(
		join(agentDir, "settings.json"),
		settingsBytes(providerId, modelId, thinkingLevel),
	);

	writeExclusiveFile(join(agentDir, "models.json"), modelsBytes(providerId, modelId, request.mockBaseUrl));

	await journal.append(
		{
			runId,
			attemptId,
			kind: "plan_committed",
			body: {
				caseLabel: request.caseLabel,
				...(options?.evidence && {
					plan: options.evidence.anchor.plan, identity: options.evidence.identity,
					corpusBefore: options.evidence.corpus.commitment,
				}),
				toolProfile: HOST_LIMITS.toolProfile,
				limits: HOST_LIMITS,
				originalQuestionSha256,
				encodedPromptSha256,
			},
		},
		nowMs(),
	);
	await journal.append(
		{
			runId,
			attemptId,
			kind: "closure_verified",
			body: {
				closureDigest: closureBefore.closureDigest,
				nativeOrigin: closureBefore.nativeSourceOrigin,
				nativeSha256: closureBefore.nativePin.sha256,
				skillOrigin: closureBefore.skillSourceOrigin,
				skillSha256: closureBefore.skillPin.sha256,
				piEntrySha256: closureBefore.piEntryPin.sha256,
				piTreeSha256: closureBefore.piTreeSha256,
			},
		},
		nowMs(),
	);

	if (!(await piStdoutSink.ready) || !(await piStderrSink.ready) || journal.hasFailed) {
		const deadline = performance.now() + HOST_LIMITS.killGraceMs;
		await Promise.all([piStdoutSink.close(deadline), piStderrSink.close(deadline), journal.close(deadline)]);
		throw new Error("Pre-launch capture or journal allocation failed");
	}

	const adapterPath = options.faultControls?.adapterPathOverride ?? resolveDefaultAdapterPath();
	const piArgs = [
		closureBefore.piEntryPin.canonicalPath,
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"-e",
		adapterPath,
		"--no-builtin-tools",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		...(options?.evidence ? ["--system-prompt", options.evidence.preamble] : []),
		"--offline",
		"--provider",
		providerId,
		"--model",
		modelId,
		"--thinking",
		thinkingLevel,
		"--api-key",
		"clec-unit1-sentinel-key",
	];

	const piEnv = buildScrubbedChildEnv({
		HOME: homeDir,
		PI_CODING_AGENT_DIR: agentDir,
		TMPDIR: tmpDir,
		TEMP: tmpDir,
		TMP: tmpDir,
	});

	let piChild: ChildProcess | null = null;

	const nativeAbort = new AbortController();
	let admissionClosed = false;
	let attemptOrdinal = 0;
	let expectedOuterWatermark = 0;
	let lastPermitAck: Extract<PipeOuterToChild, { kind: "provider_permit" }> | null = null;
	let stopTerminationStarted = false;
	const terminated = Promise.withResolvers<void>();
	let stopTicket: ArmedStop | undefined;
	let groupCleanup: Promise<void> | undefined;
	let cleanPiEof = false;
	let resolveStartupWait: ((ok: boolean, reason?: string) => void) | null = null;
	let boundReadySeen = false;
	let pendingGetStateResolve: ((res: Record<string, unknown> | null) => void) | null = null;
	let pendingIdleGetStateResolve: ((res: Record<string, unknown> | null) => void) | null = null;
	let promptPreflightSeen = false;
	let promptPreflightDisposition: string | null = null;
	let terminalAssistantStopReason: string | null = null;
	let agentSettledSeen = false;
	let settledResolve: (() => void) | null = null;
	let piExited = false;
	let piExitObservedAt: number | null = null;
	let piExitResolve: (() => void) | null = null;
	let captureDrain: DrainResult = { kind: "drained" };
	let finalCapture: AttemptReport["finalCapture"];
	let committedTurns = 0;
	let resolveTurnCommit: (() => void) | undefined;
	const committedDeclarations = new Set<string>();
	let resolveDeclarationCommit: (() => void) | undefined;

	const beginStop = (at = performance.now()): ArmedStop => {
		if (stopTicket) return stopTicket;
		admissionClosed = true;
		const trigger = { at, detectedAt: performance.now() };
		stopTicket = armStop({ trigger, child: piChild, graceMs: STOP_GRACE_MS.pi });
		registry.beginStop(trigger, options.faultControls?.injectOmitNativeTeardown === true);
		nativeAbort.abort();
		resolveStartupWait?.(false, failureReason ?? "Startup stopped");
		pendingGetStateResolve?.(null);
		pendingIdleGetStateResolve?.(null);
		settledResolve?.();
		resolveTurnCommit?.();
		resolveDeclarationCommit?.();
		piExitResolve?.();
		groupCleanup = registry.finishStop(options.faultControls?.injectPsFailure);
		return stopTicket;
	};
	const terminatePiAndGroups = (reason: string, finalStatus: AttemptStatus, at?: number): void => {
		if (!stopTicket) {
			stopTerminationStarted = true;
			failureReason = reason;
			status = finalStatus;
		}
		beginStop(at);
		terminated.resolve();
	};
	stopOnIoFailure = (reason) => terminatePiAndGroups(reason, "InvalidEvidence");
	const caseDeadlineMs = options.faultControls?.caseDeadlineMsOverride ?? HOST_LIMITS.caseDeadlineMs;
	const caseDeadline = performance.now() + caseDeadlineMs;
	const caseTimeout = (): void => terminatePiAndGroups(`Case deadline ${caseDeadlineMs} ms exceeded`, "DeniedAndTerminated", caseDeadline);
	const cancelCaseTimer = scheduleDeadline(caseDeadline, caseTimeout);
	const releaseAllowed = (): boolean => {
		if (performance.now() >= caseDeadline) caseTimeout();
		return !nativeAbort.signal.aborted && !admissionClosed;
	};

	try {
		piChild = spawn(closureBefore.nodePin.canonicalPath, piArgs, {
			cwd,
			env: piEnv,
			detached: false,
			shell: false,
			stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
		});
	} catch (err) {
		cancelCaseTimer();
		stopOnIoFailure = undefined;
		failureReason = `Failed to spawn Pi: ${err instanceof Error ? err.message : String(err)}`;
		status = "PreWorkInfrastructureFailed";
		uncertified = true;
		await journal.append({ runId, attemptId, kind: "attempt_closed", body: { status, reason: failureReason } }, nowMs(), "emergency");
		await piStdoutSink.close(performance.now() + HOST_LIMITS.killGraceMs);
		await piStderrSink.close(performance.now() + HOST_LIMITS.killGraceMs);
		await journal.close(performance.now() + HOST_LIMITS.killGraceMs);
		return publishAttemptIndex({
			certificateNotice: HOST_LIMITS.certificateNotice,
			toolProfile: HOST_LIMITS.toolProfile,
			runId,
			attemptId,
			bundleDir,
			indexEntryPath,
			status,
			failureReason,
			promptReceived: false,
			originalQuestionBytesSha256: originalQuestionSha256,
			encodedPromptBytesSha256: encodedPromptSha256,
			encodedPromptText: null,
			providerRequestsGranted: 0,
			providerRequestsDenied: 0,
			declaredToolCalls: [],
			nativeStarts: 0,
			groupObservations: [],
			answerText: null,
			piExitCode: null,
			piSignal: null,
			uncertified: true,
			rawArtifacts: { journalPath, piStdoutPath, piStderrPath },
			closureBeforeSha256: closureBefore.closureDigest,
			closureAfterSha256: null,
		});
	}

	const pi = piChild;
	const rpcIn = pi.stdin as Writable;
	const rpcOut = piChild.stdout as Readable;
	const rpcErr = piChild.stderr as Readable;
	const pipeToAdapter = piChild.stdio[3] as Writable;
	const pipeFromAdapter = piChild.stdio[4] as Readable;

	piChild.on("exit", (code, sig) => {
		piExitObservedAt = nowMs();
		piExited = true;
		piExitCode = code;
		piSignal = sig;
		if (cleanPiEof && code === 0) beginStop();
		else terminatePiAndGroups(`Pi exited unexpectedly (code=${code}, signal=${sig})`, "DeniedAndTerminated");
		piExitResolve?.();
	});
	piChild.on("error", (err) => terminatePiAndGroups(err.message, "PreWorkInfrastructureFailed"));
	for (const stream of [rpcIn, pipeToAdapter]) {
		stream.on("error", (err) => {
			if (!cleanPiEof) terminatePiAndGroups(err.message, "InvalidEvidence");
		});
	}
	const spawned = (async () => {
		const deadline = Math.min(caseDeadline, performance.now() + 3_000);
		const freshAfter = performance.now();
		let detail = "Pi PID absent from process table";
		do {
			const table = await readOsProcessTable(deadline, freshAfter);
			if (nativeAbort.signal.aborted) return;
			const row = table.ok ? table.entries.find((entry) => entry.pid === piChild?.pid && entry.ppid === process.pid) : undefined;
			if (row) {
				await journal.append({
					runId, attemptId, kind: "pi_spawned", body: { pid: row.pid, lstart: row.lstart, adapterPath,
						...(options?.evidence && { monotonicStartMs, baseUrl: request.mockBaseUrl }) },
				}, nowMs());
				return;
			}
			if (!table.ok) detail = table.reason;
			await sleepMs(25);
		} while (!nativeAbort.signal.aborted && performance.now() < deadline);
		terminatePiAndGroups(`Could not verify Pi process identity: ${detail}`, "PreWorkInfrastructureFailed");
	})();
	const stderrCaptured = captureRawStream(rpcErr, piStderrSink, (err) => ioFailure(err.message));

	const rpcReader = attachBoundedJsonlReader<Record<string, unknown>>({
		stream: rpcOut,
		maxFrameBytes: HOST_LIMITS.controlFrameBytes,
		maxAggregateBytes: HOST_LIMITS.controlAggregateBytes,
		label: "pi_rpc_stdout",
		rawSink: piStdoutSink,
		onError: (err) => {
			uncertified = true;
			terminatePiAndGroups(`Pi RPC stdout framing error: ${err.message}`, "InvalidEvidence");
		},
		onEnd: () => {
			if (!cleanPiEof) terminatePiAndGroups("Pi RPC stdout EOF", "DeniedAndTerminated");
		},
		strictFrames: options?.evidence !== undefined,
		onRecord: async (rec, frame) => {
			await spawned;
			if (options?.evidence) {
				options.evidence.pi.accept(rec);
				const committed = await journal.append({ runId, attemptId, kind: "pi_frame", body: { ...frame } }, nowMs());
				if (!committed.ok) return;
				if (rec.type === "turn_end") {
					committedTurns = options.evidence.pi.completedTurns;
					resolveTurnCommit?.();
				}
			}
			if (rec.type === "response") {
				if (rec.id === "state-1" && rec.command === "get_state") {
					pendingGetStateResolve?.(rec);
					pendingGetStateResolve = null;
					return;
				}
				if (rec.id === "state-end" && rec.command === "get_state") {
					pendingIdleGetStateResolve?.(rec);
					pendingIdleGetStateResolve = null;
					return;
				}
				if (rec.id === "prompt-1" && rec.command === "prompt") {
					if (rec.success === true) {
						const data = rec.data as Record<string, unknown> | undefined;
						promptPreflightSeen = true;
						promptPreflightDisposition = typeof data?.disposition === "string" ? data.disposition : null;
						await journal.append(
							{
								runId,
								attemptId,
								kind: "prompt_preflight",
								body: { disposition: promptPreflightDisposition },
							},
							nowMs(),
						);
					} else {
						terminatePiAndGroups(`Prompt command failed: ${String(rec.error)}`, "TaskFailed");
					}
					return;
				}
			}

			if (rec.type === "extension_error") {
				await journal.append(
					{
						runId,
						attemptId,
						kind: "journal_fault",
						body: { extensionError: rec },
					},
					nowMs(),
					"emergency",
				);
			}

			if (rec.type === "message_end") {
				const msg = rec.message as Record<string, unknown> | undefined;
				if (msg?.role === "assistant" && Array.isArray(msg.content)) {
					const batchCalls: Array<{ id: string; name: string }> = [];
					const textParts: string[] = [];
					for (const block of msg.content) {
						if (!block || typeof block !== "object") continue;
						const b = block as Record<string, unknown>;
						if (b.type === "toolCall") {
							const id = typeof b.id === "string" ? b.id : "";
							const name = typeof b.name === "string" ? b.name : "";
							batchCalls.push({ id, name });
							if (id.length === 0 || seenDeclaredCallIds.has(id)) {
								declaredToolCalls.push({ id, name, ordinal: null });
								terminatePiAndGroups(
									id.length === 0 ? "Empty toolCall.id detected" : `Duplicate toolCall.id detected: ${id}`,
									"DeniedAndTerminated",
								);
								await journal.append(
									{
										runId,
										attemptId,
										kind: "tool_start_denied",
										body: { reason: id.length === 0 ? "Empty toolCall.id" : "Duplicate toolCall.id", callId: id, name },
									},
									nowMs(),
								);
							} else {
								seenDeclaredCallIds.add(id);
								declaredToolCalls.push({
									id,
									name,
									ordinal: reservedCallOrdinals.get(id) ?? null,
								});
							}
						} else if (b.type === "text" && typeof b.text === "string") {
							textParts.push(b.text);
						}
					}
					if (batchCalls.length > 0) {
						const batchCommit = await journal.append(
							{
								runId,
								attemptId,
								kind: "tool_declared_batch",
								body: { calls: batchCalls },
							},
							nowMs(),
						);
						if (!batchCommit.ok) {
							uncertified = true;
							terminatePiAndGroups(`tool_declared_batch journal failed: ${batchCommit.error}`, "InvalidEvidence");
						} else {
							for (const call of batchCalls) committedDeclarations.add(call.id);
							resolveDeclarationCommit?.();
						}
					}
					const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : null;
					terminalAssistantStopReason = stopReason;
					if (textParts.length > 0 || stopReason === "stop" || stopReason === "error") {
						const joined = textParts.join("");
						if (Buffer.byteLength(joined, "utf8") > HOST_LIMITS.answerBytes) {
							uncertified = true;
							terminatePiAndGroups(`Answer text exceeded ${HOST_LIMITS.answerBytes} bytes`, "InvalidEvidence");
						} else if (joined.length > 0) {
							answerText = joined;
						}
					}
				}
			}

			if (rec.type === "agent_settled") {
				agentSettledSeen = true;
				await journal.append(
					{
						runId,
						attemptId,
						kind: "agent_settled",
						body: { aborted: rec.aborted === true },
					},
					nowMs(),
				);
				settledResolve?.();
			}
		},
	});

	const adapterReader = attachBoundedJsonlReader<PipeChildToOuter>({
		stream: pipeFromAdapter,
		maxFrameBytes: HOST_LIMITS.controlFrameBytes,
		maxAggregateBytes: HOST_LIMITS.controlAggregateBytes,
		label: "adapter_private_pipe",
		onError: (err) => {
			uncertified = true;
			terminatePiAndGroups(`Adapter pipe framing error: ${err.message}`, "InvalidEvidence");
		},
		onEnd: () => {
			if (!stopTicket && !cleanPiEof) {
				resolveStartupWait?.(false, "Adapter private pipe closed (EOF)");
				terminatePiAndGroups(
					"Adapter private pipe EOF",
					boundReadySeen ? "DeniedAndTerminated" : "PreWorkInfrastructureFailed",
				);
			}
		},
		onRecord: async (msg) => {
			await spawned;
			if (!releaseAllowed()) return;
			switch (msg.kind) {
				case "adapter_fault_note": {
					terminatePiAndGroups(`Adapter fault (${msg.stage}): ${msg.detail}`, "DeniedAndTerminated");
					await journal.append(
						{
							runId,
							attemptId,
							kind: "journal_fault",
							body: { stage: msg.stage, detail: msg.detail },
						},
						nowMs(),
						"emergency",
					);
					break;
				}
				case "bound_ready": {
					if (boundReadySeen) {
						terminatePiAndGroups("Duplicate bound_ready", "DeniedAndTerminated");
						return;
					}
					const validTools =
						msg.activeTools.length === 1 &&
						msg.activeTools[0] === "clec" &&
						msg.allTools.length === 1 &&
						msg.allTools[0].name === "clec" &&
						msg.allTools[0].exposure === "direct" &&
						msg.deferredTools.length === 0 &&
						deepEqualJson(msg.allTools[0].parameters, CLEC_TOOL_PARAMETERS_SCHEMA) &&
						msg.model?.provider === providerId &&
						msg.model?.id === modelId;
					if (!validTools) {
						terminatePiAndGroups(
							`BoundReady inventory/model mismatch: active=${JSON.stringify(msg.activeTools)} model=${JSON.stringify(msg.model)}`,
							"PreWorkInfrastructureFailed",
						);
						return;
					}
					const commitReady = await journal.append(
						{
							runId,
							attemptId,
							kind: "bound_ready",
							body: {
								seq: msg.seq,
								activeTools: msg.activeTools,
								deferredTools: msg.deferredTools,
								model: msg.model,
								thinkingLevel: msg.thinkingLevel,
							},
						},
						nowMs(),
					);
					if (!commitReady.ok) {
						terminatePiAndGroups(`BoundReady commit failed: ${commitReady.error}`, "PreWorkInfrastructureFailed");
						return;
					}
					const ack: PipeOuterToChild = {
						kind: "bound_ready_ack",
						seq: msg.seq,
						attemptId,
					};
					const commitAck = await journal.append(
						{ runId, attemptId, kind: "bound_ready_ack", body: { seq: msg.seq } },
						nowMs(), "durable",
					);
					if (!commitAck.ok) {
						terminatePiAndGroups(`BoundReadyAck commit failed: ${commitAck.error}`, "PreWorkInfrastructureFailed");
						return;
					}
					if (!releaseAllowed()) return;
					expectedOuterWatermark = msg.seq;
					boundReadySeen = true;
					writeBoundedFrame(pipeToAdapter, ack, HOST_LIMITS.controlFrameBytes);
					resolveStartupWait?.(true);
					break;
				}
				case "provider_candidate": {
					if (admissionClosed) {
						providerRequestsDenied += 1;
						terminatePiAndGroups("Provider request attempted after admission closed", "DeniedAndTerminated");
						await journal.append(
							{ runId, attemptId, kind: "provider_denied", body: { reason: "admissionClosed", seq: msg.seq } },
							nowMs(),
						);
						return;
					}
					const actualDigest = sha256Buffer(Buffer.from(msg.payloadJson, "utf8"));
					if (actualDigest !== msg.payloadDigest || Buffer.byteLength(msg.payloadJson) !== msg.payloadByteLength) {
						providerRequestsDenied += 1;
						terminatePiAndGroups("Provider payload digest mismatch", "DeniedAndTerminated");
						await journal.append(
							{ runId, attemptId, kind: "provider_denied", body: { reason: "digestMismatch", seq: msg.seq } },
							nowMs(),
						);
						return;
					}
					if (msg.watermark !== expectedOuterWatermark) {
						providerRequestsDenied += 1;
						terminatePiAndGroups("Provider watermark mismatch", "DeniedAndTerminated");
						await journal.append(
							{
								runId,
								attemptId,
								kind: "provider_denied",
								body: { reason: "watermarkMismatch", expected: expectedOuterWatermark, got: msg.watermark },
							},
							nowMs(),
						);
						return;
					}
					if (options.evidence && committedTurns < providerRequestsGranted) {
						await new Promise<void>(resolve => { resolveTurnCommit = resolve; });
						resolveTurnCommit = undefined;
						if (!releaseAllowed()) return;
					}
					const payloadValidation = validateProviderPayload({
						payloadJson: msg.payloadJson,
						expectedModelId: modelId,
						expectedEncodedPrompt: encodedPromptText,
						expectedSystemPrompt: options?.evidence ? systemPrompt(cwd, options.evidence.preamble) : undefined,
					});
					if (!payloadValidation.ok) {
						providerRequestsDenied += 1;
						terminatePiAndGroups(payloadValidation.reason, "DeniedAndTerminated");
						await journal.append(
							{
								runId,
								attemptId,
								kind: "provider_denied",
								body: { reason: payloadValidation.reason, seq: msg.seq },
							},
							nowMs(),
						);
						return;
					}

					options.evidence?.pi.checkProviderPrefix(msg.payloadJson);
					await checkCorpus();
					if (!releaseAllowed()) return;
					const candCommit = await journal.append(
						{
							runId,
							attemptId,
							kind: "provider_candidate",
							body: {
								...(options?.evidence && { payloadJson: msg.payloadJson }),
								seq: msg.seq,
								watermark: msg.watermark,
								payloadDigest: msg.payloadDigest,
								payloadByteLength: msg.payloadByteLength,
							},
						},
						nowMs(),
					);
					if (!candCommit.ok) {
						providerRequestsDenied += 1;
						uncertified = true;
						terminatePiAndGroups(`ProviderCandidate journal failed: ${candCommit.error}`, "InvalidEvidence");
						return;
					}

					const grantCommit = await journal.append(
						{
							runId,
							attemptId,
							kind: "provider_grant",
							body: {
								seq: msg.seq,
								watermark: msg.watermark,
								payloadDigest: msg.payloadDigest,
								attemptsUsedSoFar: attemptOrdinal,
								...(corpus && { corpus: corpus.commitment }),
							},
						},
						nowMs(), "durable",
					);
					if (!grantCommit.ok) {
						providerRequestsDenied += 1;
						uncertified = true;
						terminatePiAndGroups(`ProviderGrant journal failed before ACK: ${grantCommit.error}`, "InvalidEvidence");
						return;
					}

					const permit: PipeOuterToChild = {
						kind: "provider_permit",
						seq: msg.seq,
						attemptId,
						watermark: msg.watermark,
						payloadDigest: msg.payloadDigest,
					};

					if (!releaseAllowed()) return;

					if (options.faultControls?.injectMalformedPermitAck) {
						providerRequestsDenied += 1;
						pipeToAdapter.write('{"kind":"provider_permit","seq":999999,"bad":true}\n', "utf8");
						setTimeout(() => {
							terminatePiAndGroups("Injected malformed permit ACK", "DeniedAndTerminated");
						}, 80);
						return;
					}
					if (options.faultControls?.injectReplayedPermitAck && lastPermitAck !== null) {
						providerRequestsDenied += 1;
						writeBoundedFrame(pipeToAdapter, lastPermitAck, HOST_LIMITS.controlFrameBytes);
						setTimeout(() => {
							terminatePiAndGroups("Injected replayed permit ACK", "DeniedAndTerminated");
						}, 80);
						return;
					}

					lastPermitAck = permit;
					await checkCorpus();
					if (!releaseAllowed()) return;
					expectedOuterWatermark = msg.seq;
					providerRequestsGranted += 1;
					writeBoundedFrame(pipeToAdapter, permit, HOST_LIMITS.controlFrameBytes);

					if (options.faultControls?.injectJournalFailAfterGrant) {
						journal.setFailOnKind("tool_declared_batch");
					}
					const permitSentCommit = await journal.append(
						{
							runId,
							attemptId,
							kind: "provider_permit_sent",
							body: { seq: msg.seq, payloadDigest: msg.payloadDigest },
						},
						nowMs(),
					);
					if (!permitSentCommit.ok) {
						uncertified = true;
						terminatePiAndGroups(`Journal failed after grant: ${permitSentCommit.error}`, "InvalidEvidence");
					}
					break;
				}
				case "tool_start_observe": {
					if (admissionClosed) {
						terminatePiAndGroups("Tool start after admission closed", "DeniedAndTerminated");
						await journal.append(
							{ runId, attemptId, kind: "tool_start_denied", body: { reason: "admissionClosed", callId: msg.callId } },
							nowMs(),
						);
						return;
					}
					if (seenStartedCallIds.has(msg.callId)) {
						terminatePiAndGroups(`Duplicate tool callId at start: ${msg.callId}`, "DeniedAndTerminated");
						await journal.append(
							{ runId, attemptId, kind: "tool_start_denied", body: { reason: "duplicateCallId", callId: msg.callId } },
							nowMs(),
						);
						return;
					}
					if (options.evidence) {
						if (!committedDeclarations.has(msg.callId)) {
							await new Promise<void>(resolve => { resolveDeclarationCommit = resolve; });
							resolveDeclarationCommit = undefined;
							if (!releaseAllowed()) return;
						}
						if (!committedDeclarations.has(msg.callId) ||
							!options.evidence.pi.matchesDeclaration(msg.callId, msg.toolName, msg.args)) {
							throw new Error("Tool start differs from the raw declaration");
						}
					}
					seenStartedCallIds.add(msg.callId);
					attemptOrdinal += 1;
					reservedCallOrdinals.set(msg.callId, attemptOrdinal);
					if (attemptOrdinal > HOST_LIMITS.maxAttempts) {
						terminatePiAndGroups(
							`Attempt budget exceeded at ordinal ${attemptOrdinal} (${msg.toolName})`,
							"DeniedAndTerminated",
						);
						await journal.append(
							{
								runId,
								attemptId,
								kind: "tool_start_denied",
								body: {
									reason: "attemptBudgetExceeded",
									ordinal: attemptOrdinal,
									maxAttempts: HOST_LIMITS.maxAttempts,
									callId: msg.callId,
									toolName: msg.toolName, args: msg.args, bridgeSeq: msg.seq,
								},
							},
							nowMs(),
						);
						const existingDeclared = declaredToolCalls.find((d) => d.id === msg.callId);
						if (existingDeclared) {
							(existingDeclared as { ordinal: number | null }).ordinal = attemptOrdinal;
						}
						return;
					}
					const existingDeclared = declaredToolCalls.find((d) => d.id === msg.callId);
					if (existingDeclared) {
						(existingDeclared as { ordinal: number | null }).ordinal = attemptOrdinal;
					}
					const parsed = msg.toolName === "clec" ? parseRequest(msg.args, corpus?.index ?? {
						release: sha256Buffer(""), workIds: new Set(), sourceIds: new Set(), passageIds: new Set(),
					}) : null;
					const rejection = parsed?.ok === false ? requestRejection(parsed) : undefined;
					if (parsed?.ok) executableCalls.set(msg.callId, { ordinal: attemptOrdinal, request: parsed.request });
					const reserveCommit = await journal.append(
						{
							runId,
							attemptId,
							kind: "tool_start_reserved",
							body: {
								ordinal: attemptOrdinal, callId: msg.callId, toolName: msg.toolName, bridgeSeq: msg.seq,
								args: msg.args, rejection: parsed === null ? "UNKNOWN_TOOL" : rejection ?? null,
							},
						},
						nowMs(), "durable",
					);
					if (!reserveCommit.ok) {
						uncertified = true;
						terminatePiAndGroups(`Tool start reserve failed: ${reserveCommit.error}`, "InvalidEvidence");
						return;
					}
					if (!releaseAllowed()) return;
					expectedOuterWatermark = msg.seq;
					writeBoundedFrame(
						pipeToAdapter,
						{
							kind: "tool_start_ack",
							seq: msg.seq,
							callId: msg.callId,
							allowed: true,
							ordinal: attemptOrdinal, rejection,
						} satisfies PipeOuterToChild,
						HOST_LIMITS.controlFrameBytes,
					);
					break;
				}
				case "tool_execute": {
					const reserved = executableCalls.get(msg.callId);
					if (!reserved || msg.toolName !== "clec" || admissionClosed) {
						terminatePiAndGroups(`Unauthorized tool_execute for callId=${msg.callId}`, "DeniedAndTerminated");
						return;
					}
					executableCalls.delete(msg.callId);
					const leaseId = makeGroupLeaseId(`lease-${reserved.ordinal}`);
					const invocation = fixedInvocation(reserved.request, {
						nativePath: closureBefore.nativePin.canonicalPath, dataDir, release: corpus?.commitment.release ?? sha256Buffer(""),
					});
					const execPath = options.faultControls?.nativeExecOverride ?? invocation.execPath;
					const argv = options.faultControls?.nativeArgsOverride
						? options.faultControls.nativeArgsOverride.map((arg) =>
								arg === "__PI_PID__" ? String(piChild?.pid ?? -1) : arg,
						  )
						: invocation.argv;

					const outcome = await runRegisteredNativeGroup({
						registry,
						leaseId,
						callId: msg.callId,
						runId,
						attemptId,
						captureDir,
						dataDir,
						cwd,
						execPath,
						argv,
						helperPath: options.faultControls?.helperPathOverride,
						corpusBefore: corpus?.commitment,
						executeSeq: msg.seq,
						verifyLaunch: async () => {
							await checkCorpus();
							await verifyFilePin(closureBefore.nodePin);
							if (!options.faultControls?.helperPathOverride) await verifyFilePin(helperPin);
							if (!options.faultControls?.nativeExecOverride) await verifyFilePin(closureBefore.nativePin);
						},
						nativeSentinelPath: options.faultControls?.nativeSentinelPath,
						journal,
						monotonicStartMs,
						deadlineMs: options.faultControls?.nativeDeadlineMsOverride ?? HOST_LIMITS.nativeDeadlineMs,
						abortSignal: nativeAbort.signal,
						skipGoAndCloseHelper: options.faultControls?.injectSkipGoAndCloseHelper,
						onKillPiBetweenRegAndGo: options.faultControls?.injectKillPiBetweenRegAndGo
							? async () => {
									if (piChild && typeof piChild.pid === "number") {
										try {
											process.kill(piChild.pid, "SIGKILL");
										} catch {
											// Ignore
										}
										await sleepMs(60);
									}
							  }
							: undefined,
						onNativeFirstChunk: options.faultControls?.injectKillPiDuringNativeOutput
							? () => {
									if (piChild && typeof piChild.pid === "number") {
										try {
											process.kill(piChild.pid, "SIGKILL");
										} catch {
											// Ignore
										}
									}
							  }
							: undefined,
						onOverflow: (stream, bytes) => {
							ioFailure(`${stream} overflow: ${bytes}`);
							overflow = { stream, observedBytes: bytes };
						},
						onSinkFailure: (stream, err) => ioFailure(`${stream}: ${err.message}`),
						onInvalidStdout: () => ioFailure("Successful native stdout is invalid UTF-8"),
						sinkStallMs: options.faultControls?.simulatedSinkStallMs,
						onFatal: (reason, at) => terminatePiAndGroups(reason, "DeniedAndTerminated", at),
					});
					if (!releaseAllowed()) return;
					const entry = registry.entries.get(leaseId);
					if (!entry) throw new Error("Native lease was not reserved");
					const at = performance.now();
					registry.beginOne(entry, { at, detectedAt: at });
					await registry.finishOne(entry, options.faultControls?.injectPsFailure);
					if (!releaseAllowed()) return;
					if (entry.state !== "Closed" || entry.stop?.evidence.drain?.kind !== "drained") {
						ioFailure("Native closure or drain is incomplete");
						return;
					}

					await checkCorpus();
					await verifyFilePin(closureBefore.nativePin);
					if (!releaseAllowed()) return;
					const toolResultText = outcome.ok
						? outcome.stdoutText
						: nativeErrorText(outcome.exitCode, outcome.stderrText);

					const delivery = await journal.append(
						{
							runId,
							attemptId,
							kind: "tool_result_delivered",
							body: {
								leaseId,
								callId: msg.callId,
								isError: !outcome.ok,
								stdoutBytes: entry.stdoutSink.bytesWritten,
								resultSha256: sha256Buffer(toolResultText),
								stderrBytes: entry.stderrSink.bytesWritten,
								...(corpus && { corpusAfter: corpus.commitment, nativeSha256: closureBefore.nativePin.sha256 }),
							},
						},
						nowMs(), "durable",
					);

					if (!delivery.ok || !releaseAllowed()) return;
					writeBoundedFrame(
						pipeToAdapter,
						{
							kind: "tool_result",
							seq: msg.seq,
							callId: msg.callId,
							isError: !outcome.ok,
							text: toolResultText,
						} satisfies PipeOuterToChild,
						HOST_LIMITS.controlFrameBytes,
					);
					break;
				}
			}
		},
	});

	const driveRpc = async (): Promise<void> => {
		if (options.faultControls?.injectKillPiBeforeReady && typeof pi.pid === "number") {
			try {
				process.kill(pi.pid, "SIGKILL");
			} catch {
				// Ignore
			}
		}

		if (!options.faultControls?.bypassReadyCheck) {
			const startupTimeoutMs = options.faultControls?.startupTimeoutMsOverride ?? HOST_LIMITS.startupTimeoutMs;
			const readyOk = await new Promise<{ readonly ok: boolean; readonly reason?: string }>((res) => {
				const timer = setTimeout(() => {
					resolveStartupWait = null;
					res({ ok: false, reason: `Timed out waiting for BoundReady (${startupTimeoutMs} ms)` });
				}, startupTimeoutMs);
				resolveStartupWait = (ok, reason) => {
					clearTimeout(timer);
					resolveStartupWait = null;
					res({ ok, reason });
				};
				if (boundReadySeen) {
					clearTimeout(timer);
					resolveStartupWait = null;
					res({ ok: true });
				} else if (stopTicket || piExited) {
					clearTimeout(timer);
					resolveStartupWait = null;
					res({ ok: false, reason: `Pi exited before BoundReady (code=${String(piExitCode)})` });
				}
			});
			if (!readyOk.ok) {
				terminatePiAndGroups(readyOk.reason ?? "Startup readiness failed", "PreWorkInfrastructureFailed");
				throw new Error(readyOk.reason ?? "Startup readiness failed");
			}
		} else {
			uncertified = true;
			await sleepMs(150);
		}

		const getStateRes = await new Promise<Record<string, unknown> | null>((res) => {
			const timer = setTimeout(() => {
				pendingGetStateResolve = null;
				res(null);
			}, 10_000);
			pendingGetStateResolve = (r) => {
				clearTimeout(timer);
				res(r);
			};
			if (!releaseAllowed() || piExited) {
				clearTimeout(timer);
				pendingGetStateResolve = null;
				res(null);
				return;
			}
			writeBoundedFrame(rpcIn, { id: "state-1", type: "get_state" }, HOST_LIMITS.controlFrameBytes);
		});

		if (!getStateRes || getStateRes.success !== true) {
			const reason = `get_state failed or timed out: ${JSON.stringify(getStateRes)}`;
			terminatePiAndGroups(reason, "PreWorkInfrastructureFailed");
			throw new Error(reason);
		}

		const stateData = (getStateRes.data ?? {}) as Record<string, unknown>;
		const stateModel = stateData.model as Record<string, unknown> | undefined;
		const stateValid =
			stateModel?.provider === providerId &&
			stateModel?.id === modelId &&
			stateData.thinkingLevel === thinkingLevel &&
			stateData.isStreaming === false &&
			stateData.isCompacting === false &&
			stateData.messageCount === 0 &&
			stateData.pendingMessageCount === 0 &&
			stateData.sessionFile === undefined &&
			stateData.autoCompactionEnabled === false;

		if (!stateValid) {
			const reason = `get_state invariant violation: ${JSON.stringify(stateData)}`;
			terminatePiAndGroups(reason, "PreWorkInfrastructureFailed");
			throw new Error(reason);
		}

		const stateCommit = await journal.append(
			{
				runId,
				attemptId,
				kind: "get_state_ok",
				body: {
					modelProvider: stateModel?.provider,
					modelId: stateModel?.id,
					thinkingLevel: stateData.thinkingLevel,
					autoCompactionEnabled: stateData.autoCompactionEnabled,
					...(options?.evidence && { sessionId: stateData.sessionId, baseUrl: stateModel?.baseUrl }),
				},
			},
			nowMs(),
		);
		if (!stateCommit.ok) {
			uncertified = true;
			terminatePiAndGroups(`get_state journal failed: ${stateCommit.error}`, "InvalidEvidence");
			throw new Error(stateCommit.error);
		}

		const promptEncodeCommit = await journal.append(
			{
				runId,
				attemptId,
				kind: "prompt_encoded",
				body: {
					originalQuestionSha256,
					encodedPromptSha256,
					encodedByteLength: Buffer.byteLength(encodedPromptText, "utf8"),
				},
			},
			nowMs(),
		);
		if (!promptEncodeCommit.ok) {
			uncertified = true;
			terminatePiAndGroups(`prompt_encoded journal failed: ${promptEncodeCommit.error}`, "InvalidEvidence");
			throw new Error(promptEncodeCommit.error);
		}

		const promptCommit = await journal.append({ runId, attemptId, kind: "prompt_sent", body: { id: "prompt-1", ...(options?.evidence && { message: encodedPromptText }) } }, nowMs(), "durable");
		if (!promptCommit.ok || !releaseAllowed()) throw new Error("Prompt release closed");
		promptReceived = true;
		writeBoundedFrame(
			rpcIn,
			{ id: "prompt-1", type: "prompt", message: encodedPromptText },
			HOST_LIMITS.controlFrameBytes,
		);

		await new Promise<void>((res) => {
			if (agentSettledSeen || piExited || stopTerminationStarted) {
				res();
				return;
			}
			settledResolve = () => {
				settledResolve = null;
				res();
			};
		});

		if (agentSettledSeen && !stopTerminationStarted && !piExited) {
			const idleRes = await new Promise<Record<string, unknown> | null>((res) => {
				const timer = setTimeout(() => {
					pendingIdleGetStateResolve = null;
					res(null);
				}, 5_000);
				pendingIdleGetStateResolve = (r) => {
					clearTimeout(timer);
					res(r);
				};
				writeBoundedFrame(rpcIn, { id: "state-end", type: "get_state" }, HOST_LIMITS.controlFrameBytes);
			});
			const idleData = (idleRes?.data ?? {}) as Record<string, unknown>;
			const isIdle =
				idleRes?.success === true &&
				idleData.isStreaming === false &&
				idleData.isCompacting === false &&
				idleData.pendingMessageCount === 0;

			if (releaseAllowed()) {
				cleanPiEof = isIdle;
				rpcIn.end();
			}
			await new Promise<void>((res) => {
				if (piExited || stopTicket) {
					res();
					return;
				}
				const t = setTimeout(() => {
					piExitResolve = null;
					res();
				}, HOST_LIMITS.killGraceMs);
				piExitResolve = () => {
					clearTimeout(t);
					piExitResolve = null;
					res();
				};
			});

			if (!piExited) {
				terminatePiAndGroups("Pi did not exit cleanly after RPC stdin EOF", "TaskFailed");
			} else if (
				!stopTerminationStarted &&
				promptPreflightSeen &&
				promptPreflightDisposition === "started" &&
				isIdle &&
				terminalAssistantStopReason === "stop" &&
				answerText !== null &&
				answerText.length > 0 &&
				!uncertified &&
				!journal.hasFailed
			) {
				status = "Answered";
				failureReason = null;
			} else if (!stopTerminationStarted) {
				status = uncertified || journal.hasFailed ? "InvalidEvidence" : "TaskFailed";
				failureReason =
					failureReason ??
					`Incomplete answer criteria: preflight=${String(promptPreflightDisposition)} idle=${String(isIdle)} stop=${String(terminalAssistantStopReason)} answer=${String(answerText !== null)}`;
			}
		} else if (!stopTerminationStarted) {
			terminatePiAndGroups("Pi exited unexpectedly before agent_settled", "DeniedAndTerminated");
		}
	};

	try {
		await Promise.race([driveRpc(), terminated.promise]);
	} catch (err) {
		if (!stopTerminationStarted) {
			terminatePiAndGroups(err instanceof Error ? err.message : String(err), status);
		}
	} finally {
		cancelCaseTimer();
		const ticket = beginStop();
		const { evidence } = ticket;
		const capture = async (): Promise<DrainResult> => {
			const streams = await byDeadline(Promise.all([rpcReader.done, stderrCaptured]), evidence.drainDeadline);
			if (streams.kind === "timeout") {
				rpcReader.stop();
				rpcErr.destroy();
			}
			const files = await Promise.all([piStdoutSink.close(evidence.drainDeadline), piStderrSink.close(evidence.drainDeadline)]);
			const result: DrainResult = streams.kind === "timeout"
				? { kind: "incomplete", reason: "Pi raw stream deadline" }
				: [...streams.value, ...files].find((result) => result.kind === "incomplete") ?? { kind: "drained" };
			evidence.drainCompletedAt = performance.now();
			return result;
		};
		const [reaped, drained] = await Promise.all([
			byDeadline(ticket.reaped, evidence.observationDeadline),
			capture(),
			groupCleanup,
		]);
		evidence.observationCompletedAt = evidence.reapedAt;
		evidence.drain = drained;
		adapterReader.stop();
		if (reaped.kind === "timeout" || (evidence.reapedAt ?? Infinity) > evidence.observationDeadline ||
			drained.kind === "incomplete" || !boundReadySeen || options.faultControls?.bypassReadyCheck || journal.hasFailed) {
			uncertified = true;
		}
		const missedSignal = (e: ArmedStop["evidence"]): boolean => e.killAttemptAt !== null && e.killAttemptAt > e.signalDeadline;
		if (missedSignal(evidence)) uncertified = true;
		nativeStarts = [...registry.entries.values()].filter((g) => g.nativePid !== null).length;
		for (const g of registry.entries.values()) {
			const stop = g.stop?.evidence;
			if (g.state !== "Closed" || (stop && (stop.drain?.kind !== "drained" || missedSignal(stop)))) {
				uncertified = true;
			}
		}
		if (uncertified) status = invalidateAnswer(status);
		const recordCleanup = async (): Promise<boolean> => {
			const record = async (kind: AttemptJournalRecord["kind"], body: Record<string, unknown>): Promise<boolean> => {
				if (performance.now() >= evidence.drainDeadline) return false;
				return (await journal.append({ runId, attemptId, kind, body }, nowMs(), "emergency")).ok;
			};
			if (overflow && !await record("overflow_uncertified", overflow)) return false;
			if (!await record("pi_exited", { code: piExitCode, signal: piSignal, stop: evidence,
				...(options?.evidence && { observedAtMonotonicMs: piExitObservedAt }) })) return false;
			for (const g of registry.entries.values()) {
				if (!await record("group_closure_observed", { leaseId: g.leaseId, observation: g.closure, stop: g.stop?.evidence })) {
					return false;
				}
			}
			return record("attempt_closed", {
				status, failureReason, uncertified, nativeStarts, providerRequestsGranted, providerRequestsDenied,
			});
		};
		const recorded = await byDeadline(recordCleanup(), evidence.drainDeadline);
		const journalDrain = await journal.close(evidence.drainDeadline);
		captureDrain = drained.kind === "incomplete" ? drained
			: recorded.kind === "timeout" || !recorded.value ? { kind: "incomplete", reason: "Final journal records incomplete" }
			: journalDrain;
		if (captureDrain.kind === "incomplete" || journal.hasFailed) {
			uncertified = true;
			status = invalidateAnswer(status);
		}
		if (options?.evidence && captureDrain.kind === "drained" && !journal.hasFailed) {
			finalCapture = { closedAtMonotonicMs: nowMs(), journalSeq: journal.currentSeq, journalBytes: journal.writtenBytes };
		}
	}

	// Unknown ownership can outlive the proof. Skip synchronous final pin work on that path.
	const targetsClosed = piExited && [...registry.entries.values()].every((g) => g.state === "Closed");
	const closureAfter = targetsClosed && !options?.cachedClosure ? captureExecutionClosure() : null;

	const groupObservations = Array.from(registry.entries.values()).map((entry) => ({
		leaseId: entry.leaseId,
		state: entry.state,
		pgid: entry.pgid,
		helperPid: entry.helperPid,
		nativePid: entry.nativePid,
		registeredBeforeGo: entry.registeredBeforeGo,
		sentinelAbsentAtRegistration: entry.sentinelAbsentAtRegistration,
		stop: entry.stop?.evidence ?? null,
		killEscalationMs: entry.stop?.evidence.killAttemptAt == null ? null
			: entry.stop.evidence.killAttemptAt - entry.stop.evidence.triggerAt,
		closure: entry.closure,
	}));

	const result: AttemptReport = {
		certificateNotice: HOST_LIMITS.certificateNotice,
		toolProfile: HOST_LIMITS.toolProfile,
		runId,
		attemptId,
		bundleDir,
		indexEntryPath,
		status,
		failureReason,
		promptReceived,
		originalQuestionBytesSha256: originalQuestionSha256,
		encodedPromptBytesSha256: encodedPromptSha256,
		encodedPromptText: promptReceived ? encodedPromptText : null,
		providerRequestsGranted,
		providerRequestsDenied,
		declaredToolCalls,
		nativeStarts,
		groupObservations,
		answerText,
		piPid: piChild.pid ?? null,
		piExitCode,
		piSignal,
		piStop: stopTicket?.evidence,
		captureDrain,
		...(finalCapture && { finalCapture }),
		uncertified,
		rawArtifacts: { journalPath, piStdoutPath, piStderrPath },
		closureBeforeSha256: closureBefore.closureDigest,
		closureAfterSha256: closureAfter?.closureDigest ?? null,
	};

	return publishAttemptIndex(result);
}

async function publishAttemptIndex(result: AttemptReport): Promise<AttemptReport> {
	const snapshot = structuredClone(result);
	try {
		await publishExclusiveIndex(snapshot.indexEntryPath, JSON.stringify(snapshot, null, 2));
		return snapshot;
	} catch (err) {
		return {
			...snapshot, status: "InvalidEvidence", uncertified: true,
			indexPublicationError: err instanceof Error ? err.message : String(err),
		};
	}
}

function invalidateAnswer(status: AttemptStatus): AttemptStatus {
	return status === "Answered" ? "InvalidEvidence" : status;
}

function sleepMs(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}
