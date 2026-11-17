import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
	attachBoundedJsonlReader,
	BoundedJournalWriter,
	BoundedRawSink,
	createExclusiveDir,
	writeBoundedFrame,
	writeExclusiveFile,
} from "./framing.ts";
import {
	buildScrubbedChildEnv,
	captureExecutionClosure,
	type ExecutionClosure,
	PI_BUNDLE_ENTRY,
	sha256Buffer,
} from "./pins.ts";
import {
	observeGroupInProcessTable,
	ProcessGroupRegistry,
	readOsProcessTable,
	runRegisteredNativeGroup,
} from "./process-group.ts";
import type {
	AttemptId,
	AttemptStatus,
	GroupLeaseId,
	PipeChildToOuter,
	PipeOuterToChild,
	ProcessObservation,
	ProofJournalRecord,
	ProofRunResult,
	RunId,
	Sha256Hex,
	Unit1RunRequest,
} from "./types.ts";
import { makeAttemptId, makeGroupLeaseId, makeRunId, UNIT1_LIMITS } from "./types.ts";

const EXPECTED_UNIT1_CLEC_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		action: {
			const: "status",
			type: "string",
		},
	},
	required: ["action"],
};

function deepEqualJson(a: unknown, b: unknown): boolean {
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

function extractUserContentText(content: unknown): string | null {
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

function validateProviderPayload(params: {
	readonly payloadJson: string;
	readonly expectedModelId: string;
	readonly expectedEncodedPrompt: string;
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
	if (!deepEqualJson(fn?.parameters, EXPECTED_UNIT1_CLEC_SCHEMA)) {
		return { ok: false, reason: `CLEC tool schema drift: ${JSON.stringify(fn?.parameters)}` };
	}
	return { ok: true };
}

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
	return resolve(import.meta.dirname, "clec-adapter.ts");
}

export async function runUnit1Proof(
	request: Unit1RunRequest,
	options?: { readonly cachedClosure?: ExecutionClosure },
): Promise<ProofRunResult> {
	const monotonicStartMs = performance.now();
	const nowMs = (): number => Math.round(performance.now() - monotonicStartMs);

	const runId = makeRunId(`u1-${Date.now()}-${randomBytes(4).toString("hex")}`);
	const attemptId = request.faults?.duplicateAttemptIdCollision ?? makeAttemptId(`${runId}-a1`);

	const closureBefore = options?.cachedClosure ?? captureExecutionClosure();

	const bundleDir = join(request.evidenceParentDir, runId);
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
	const indexEntryPath = join(indexDir, `${runId}.json`);

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
		const collisionJournal = new BoundedJournalWriter({ path: join(bundleDir, "collision.journal.jsonl") });
		collisionJournal.append(
			{
				runId,
				attemptId,
				kind: "attempt_closed",
				body: { status: "PreWorkInfrastructureFailed", reason: `Exclusive resource collision: ${msg}` },
			},
			nowMs(),
			true,
		);
		collisionJournal.close();
		writeExclusiveFile(
			indexEntryPath,
			JSON.stringify(
				{
					certificateNotice: UNIT1_LIMITS.certificateNotice,
					runId,
					attemptId,
					caseLabel: request.caseLabel,
					status: "PreWorkInfrastructureFailed",
					reason: `Exclusive resource collision: ${msg}`,
					closureBeforeSha256: closureBefore.closureDigest,
				},
				null,
				2,
			),
		);
		return {
			certificateNotice: UNIT1_LIMITS.certificateNotice,
			toolProfile: UNIT1_LIMITS.toolProfile,
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
			rawArtifacts: { journalPath, piStdoutPath, piStderrPath },
			closureBeforeSha256: closureBefore.closureDigest,
			closureAfterSha256: null,
		};
	}

	const journal = new BoundedJournalWriter({
		path: journalPath,
		failNextKind: request.faults?.injectJournalFailOnKind,
	});

	let uncertified = false;
	let piOverflowed = false;
	const piStdoutSink = new BoundedRawSink({
		path: piStdoutPath,
		maxBytes: UNIT1_LIMITS.piStdoutBytes,
		stallMs: request.faults?.simulatedSinkStallMs,
		onOverflow: (observedBytes) => {
			piOverflowed = true;
			uncertified = true;
			journal.append(
				{
					runId,
					attemptId,
					kind: "overflow_uncertified",
					body: { stream: "pi_stdout", limit: UNIT1_LIMITS.piStdoutBytes, observedBytes },
				},
				nowMs(),
				true,
			);
		},
		onWriteFailure: (err) => {
			uncertified = true;
			journal.append(
				{ runId, attemptId, kind: "journal_fault", body: { stream: "pi_stdout", error: err.message } },
				nowMs(),
				true,
			);
		},
	});
	const piStderrSink = new BoundedRawSink({
		path: piStderrPath,
		maxBytes: UNIT1_LIMITS.piStderrBytes,
		stallMs: request.faults?.simulatedSinkStallMs,
		onOverflow: (observedBytes) => {
			piOverflowed = true;
			uncertified = true;
			journal.append(
				{
					runId,
					attemptId,
					kind: "overflow_uncertified",
					body: { stream: "pi_stderr", limit: UNIT1_LIMITS.piStderrBytes, observedBytes },
				},
				nowMs(),
				true,
			);
		},
		onWriteFailure: (err) => {
			uncertified = true;
			journal.append(
				{ runId, attemptId, kind: "journal_fault", body: { stream: "pi_stderr", error: err.message } },
				nowMs(),
				true,
			);
		},
	});

	const providerId = request.providerId ?? "mock-openai";
	const modelId = request.modelId ?? "mock-gpt";
	const thinkingLevel = request.thinkingLevel ?? "off";
	const registry = new ProcessGroupRegistry(monotonicStartMs);

	const originalQuestionSha256 = sha256Buffer(Buffer.from(request.question, "utf8"));
	const encodedPromptText = request.faults?.alterPromptEncoder
		? request.faults.alterPromptEncoder(request.question)
		: `${UNIT1_LIMITS.promptPrefix}${request.question}`;
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

	if (request.faults?.precreateAgentDirFile) {
		writeExclusiveFile(
			join(agentDir, request.faults.precreateAgentDirFile.relativePath),
			request.faults.precreateAgentDirFile.content,
		);
	}

	const precheck = validateAgentDirPreLaunch(agentDir, cwd);
	if (!precheck.ok) {
		uncertified = true;
		failureReason = precheck.reason;
		journal.append(
			{ runId, attemptId, kind: "attempt_closed", body: { status, reason: precheck.reason } },
			nowMs(),
			true,
		);
		piStdoutSink.close();
		piStderrSink.close();
		journal.close();
		writeExclusiveFile(
			indexEntryPath,
			JSON.stringify(
				{
					certificateNotice: UNIT1_LIMITS.certificateNotice,
					runId,
					attemptId,
					caseLabel: request.caseLabel,
					status,
					reason: failureReason,
					closureBeforeSha256: closureBefore.closureDigest,
				},
				null,
				2,
			),
		);
		return {
			certificateNotice: UNIT1_LIMITS.certificateNotice,
			toolProfile: UNIT1_LIMITS.toolProfile,
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
		};
	}

	writeExclusiveFile(
		join(agentDir, "settings.json"),
		JSON.stringify(
			{
				defaultProvider: providerId,
				defaultModel: modelId,
				defaultThinkingLevel: thinkingLevel,
				compaction: { enabled: false },
				cacheWarming: "off",
				retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
				enableInstallTelemetry: false,
				enableAnalytics: false,
				defaultTools: [],
			},
			null,
			2,
		),
	);

	writeExclusiveFile(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					[providerId]: {
						baseUrl: request.mockBaseUrl,
						api: "openai-completions",
						apiKey: "clec-unit1-sentinel-key",
						authHeader: true,
						models: [
							{
								id: modelId,
								name: "Unit 1 Loopback Mock",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128000,
								maxTokens: 4096,
							},
						],
					},
				},
			},
			null,
			2,
		),
	);

	journal.append(
		{
			runId,
			attemptId,
			kind: "plan_committed",
			body: {
				caseLabel: request.caseLabel,
				toolProfile: UNIT1_LIMITS.toolProfile,
				limits: UNIT1_LIMITS,
				originalQuestionSha256,
				encodedPromptSha256,
			},
		},
		nowMs(),
	);
	journal.append(
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

	const adapterPath = request.faults?.adapterPathOverride ?? resolveDefaultAdapterPath();
	const piArgs = [
		PI_BUNDLE_ENTRY,
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
	let piLstart: string | null = null;
	const nativeAbort = new AbortController();
	let admissionClosed = false;
	let attemptOrdinal = 0;
	let expectedOuterWatermark = 0;
	let lastPermitAck: Extract<PipeOuterToChild, { kind: "provider_permit" }> | null = null;
	let nativeQueue: Promise<void> = Promise.resolve();
	let stopTerminationStarted = false;
	let terminationPromise: Promise<void> | null = null;

	const terminatePiAndGroups = (reason: string, finalStatus: AttemptStatus): Promise<void> => {
		if (terminationPromise !== null) return terminationPromise;
		stopTerminationStarted = true;
		admissionClosed = true;
		if (failureReason === null) failureReason = reason;
		status = finalStatus;
		nativeAbort.abort();
		terminationPromise = (async () => {
			if (piChild && piChild.exitCode === null && piChild.signalCode === null && typeof piChild.pid === "number") {
				const killStart = performance.now();
				try {
					piChild.kill("SIGTERM");
				} catch {
					// Ignore
				}
				const termWait = new Promise<void>((res) => {
					const onEx = () => res();
					piChild!.once("exit", onEx);
					setTimeout(() => {
						piChild!.off("exit", onEx);
						res();
					}, 350);
				});
				await termWait;
				if (piChild.exitCode === null && piChild.signalCode === null) {
					try {
						piChild.kill("SIGKILL");
					} catch {
						// Ignore
					}
					await new Promise<void>((res) => {
						const onEx = () => res();
						piChild!.once("exit", onEx);
						setTimeout(() => {
							piChild!.off("exit", onEx);
							res();
						}, Math.max(200, UNIT1_LIMITS.killGraceMs - Math.round(performance.now() - killStart)));
					});
				}
			}
			await registry.stopAll({
				journal,
				runId,
				attemptId,
				injectPsFailure: request.faults?.injectPsFailure,
				omitTeardownForTesting: request.faults?.injectOmitNativeTeardown,
			});
		})();
		return terminationPromise;
	};

	try {
		piChild = spawn(process.execPath, piArgs, {
			cwd,
			env: piEnv,
			detached: false,
			shell: false,
			stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
		});
	} catch (err) {
		failureReason = `Failed to spawn Pi: ${err instanceof Error ? err.message : String(err)}`;
		status = "PreWorkInfrastructureFailed";
		uncertified = true;
		journal.append({ runId, attemptId, kind: "attempt_closed", body: { status, reason: failureReason } }, nowMs(), true);
		piStdoutSink.close();
		piStderrSink.close();
		journal.close();
		writeExclusiveFile(
			indexEntryPath,
			JSON.stringify({ certificateNotice: UNIT1_LIMITS.certificateNotice, runId, attemptId, status, reason: failureReason }, null, 2),
		);
		return {
			certificateNotice: UNIT1_LIMITS.certificateNotice,
			toolProfile: UNIT1_LIMITS.toolProfile,
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
		};
	}

	const rpcIn = piChild.stdin as Writable;
	const rpcOut = piChild.stdout as Readable;
	const rpcErr = piChild.stderr as Readable;
	const pipeToAdapter = piChild.stdio[3] as Writable;
	const pipeFromAdapter = piChild.stdio[4] as Readable;

	if (typeof piChild.pid === "number") {
		const t = readOsProcessTable();
		const entry = t.ok ? t.entries.find((e) => e.pid === piChild!.pid) : undefined;
		piLstart = entry?.lstart ?? null;
	}

	journal.append(
		{
			runId,
			attemptId,
			kind: "pi_spawned",
			body: { pid: piChild.pid ?? null, lstart: piLstart, adapterPath },
		},
		nowMs(),
	);

	let resolveStartupWait: ((ok: boolean, reason?: string) => void) | null = null;
	let boundReadySeen = false;
	let pendingGetStateResolve: ((res: Record<string, unknown>) => void) | null = null;
	let pendingIdleGetStateResolve: ((res: Record<string, unknown>) => void) | null = null;
	let promptPreflightSeen = false;
	let promptPreflightDisposition: string | null = null;
	let terminalAssistantStopReason: string | null = null;
	let agentSettledSeen = false;
	let settledResolve: (() => void) | null = null;
	let piExited = false;
	let piExitResolve: (() => void) | null = null;

	piChild.on("exit", (code, sig) => {
		piExited = true;
		piExitCode = code;
		piSignal = sig;
		nativeAbort.abort();
		journal.append(
			{
				runId,
				attemptId,
				kind: "pi_exited",
				body: { code, signal: sig },
			},
			nowMs(),
			true,
		);
		resolveStartupWait?.(false, `Pi exited early (code=${String(code)}, sig=${String(sig)})`);
		settledResolve?.();
		piExitResolve?.();
	});

	rpcErr.on("data", (chunk: Buffer) => {
		const ok = piStderrSink.writeChunk(chunk, () => rpcErr.pause(), () => rpcErr.resume());
		if (!ok && piStderrSink.hasOverflowed) {
			void terminatePiAndGroups("Pi stderr exceeded 65536 bytes", "InvalidEvidence");
		}
	});

	const detachRpcReader = attachBoundedJsonlReader<Record<string, unknown>>({
		stream: rpcOut,
		maxFrameBytes: UNIT1_LIMITS.controlFrameBytes,
		maxAggregateBytes: UNIT1_LIMITS.controlAggregateBytes,
		label: "pi_rpc_stdout",
		onRawChunk: (chunk) => {
			const ok = piStdoutSink.writeChunk(chunk, () => rpcOut.pause(), () => rpcOut.resume());
			if (!ok && piStdoutSink.hasOverflowed) {
				void terminatePiAndGroups("Pi stdout exceeded 16 MiB cap", "InvalidEvidence");
			}
		},
		onError: (err) => {
			uncertified = true;
			void terminatePiAndGroups(`Pi RPC stdout framing error: ${err.message}`, "InvalidEvidence");
		},
		onEnd: () => {
			resolveStartupWait?.(false, "Pi RPC stdout EOF before startup completed");
			settledResolve?.();
		},
		onRecord: (rec) => {
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
						journal.append(
							{
								runId,
								attemptId,
								kind: "prompt_preflight",
								body: { disposition: promptPreflightDisposition },
							},
							nowMs(),
						);
					} else {
						void terminatePiAndGroups(`Prompt command failed: ${String(rec.error)}`, "TaskFailed");
					}
					return;
				}
			}

			if (rec.type === "extension_error") {
				journal.append(
					{
						runId,
						attemptId,
						kind: "journal_fault",
						body: { extensionError: rec },
					},
					nowMs(),
					true,
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
								journal.append(
									{
										runId,
										attemptId,
										kind: "tool_start_denied",
										body: { reason: id.length === 0 ? "Empty toolCall.id" : "Duplicate toolCall.id", callId: id, name },
									},
									nowMs(),
								);
								void terminatePiAndGroups(
									id.length === 0 ? "Empty toolCall.id detected" : `Duplicate toolCall.id detected: ${id}`,
									"DeniedAndTerminated",
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
						const batchCommit = journal.append(
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
							void terminatePiAndGroups(`tool_declared_batch journal failed: ${batchCommit.error}`, "InvalidEvidence");
						}
					}
					const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : null;
					terminalAssistantStopReason = stopReason;
					if (textParts.length > 0 || stopReason === "stop" || stopReason === "error") {
						const joined = textParts.join("");
						if (Buffer.byteLength(joined, "utf8") > UNIT1_LIMITS.answerBytes) {
							uncertified = true;
							void terminatePiAndGroups(`Answer text exceeded ${UNIT1_LIMITS.answerBytes} bytes`, "InvalidEvidence");
						} else if (joined.length > 0) {
							answerText = joined;
						}
					}
				}
			}

			if (rec.type === "agent_settled") {
				agentSettledSeen = true;
				journal.append(
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

	const detachAdapterReader = attachBoundedJsonlReader<PipeChildToOuter>({
		stream: pipeFromAdapter,
		maxFrameBytes: UNIT1_LIMITS.controlFrameBytes,
		maxAggregateBytes: UNIT1_LIMITS.controlAggregateBytes,
		label: "adapter_private_pipe",
		onError: (err) => {
			uncertified = true;
			void terminatePiAndGroups(`Adapter pipe framing error: ${err.message}`, "InvalidEvidence");
		},
		onEnd: () => {
			if (!stopTerminationStarted && !agentSettledSeen) {
				resolveStartupWait?.(false, "Adapter private pipe closed (EOF)");
				void terminatePiAndGroups(
					"Adapter private pipe EOF",
					boundReadySeen ? "DeniedAndTerminated" : "PreWorkInfrastructureFailed",
				);
			}
		},
		onRecord: (msg) => {
			switch (msg.kind) {
				case "adapter_fault_note": {
					journal.append(
						{
							runId,
							attemptId,
							kind: "journal_fault",
							body: { stage: msg.stage, detail: msg.detail },
						},
						nowMs(),
						true,
					);
					void terminatePiAndGroups(`Adapter fault (${msg.stage}): ${msg.detail}`, "DeniedAndTerminated");
					break;
				}
				case "bound_ready": {
					if (boundReadySeen) {
						void terminatePiAndGroups("Duplicate bound_ready", "DeniedAndTerminated");
						return;
					}
					const validTools =
						msg.activeTools.length === 1 &&
						msg.activeTools[0] === "clec" &&
						msg.allTools.length === 1 &&
						msg.allTools[0].name === "clec" &&
						msg.allTools[0].exposure === "direct" &&
						msg.deferredTools.length === 0 &&
						deepEqualJson(msg.allTools[0].parameters, EXPECTED_UNIT1_CLEC_SCHEMA) &&
						msg.model?.provider === providerId &&
						msg.model?.id === modelId;
					if (!validTools) {
						void terminatePiAndGroups(
							`BoundReady inventory/model mismatch: active=${JSON.stringify(msg.activeTools)} model=${JSON.stringify(msg.model)}`,
							"PreWorkInfrastructureFailed",
						);
						return;
					}
					const commitReady = journal.append(
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
						void terminatePiAndGroups(`BoundReady commit failed: ${commitReady.error}`, "PreWorkInfrastructureFailed");
						return;
					}
					const ack: PipeOuterToChild = {
						kind: "bound_ready_ack",
						seq: msg.seq,
						attemptId,
					};
					const commitAck = journal.append(
						{ runId, attemptId, kind: "bound_ready_ack", body: { seq: msg.seq } },
						nowMs(),
					);
					if (!commitAck.ok) {
						void terminatePiAndGroups(`BoundReadyAck commit failed: ${commitAck.error}`, "PreWorkInfrastructureFailed");
						return;
					}
					expectedOuterWatermark = msg.seq;
					boundReadySeen = true;
					writeBoundedFrame(pipeToAdapter, ack, UNIT1_LIMITS.controlFrameBytes);
					resolveStartupWait?.(true);
					break;
				}
				case "provider_candidate": {
					if (admissionClosed) {
						providerRequestsDenied += 1;
						journal.append(
							{ runId, attemptId, kind: "provider_denied", body: { reason: "admissionClosed", seq: msg.seq } },
							nowMs(),
						);
						void terminatePiAndGroups("Provider request attempted after admission closed", "DeniedAndTerminated");
						return;
					}
					const actualDigest = sha256Buffer(Buffer.from(msg.payloadJson, "utf8"));
					if (actualDigest !== msg.payloadDigest) {
						providerRequestsDenied += 1;
						journal.append(
							{ runId, attemptId, kind: "provider_denied", body: { reason: "digestMismatch", seq: msg.seq } },
							nowMs(),
						);
						void terminatePiAndGroups("Provider payload digest mismatch", "DeniedAndTerminated");
						return;
					}
					if (msg.watermark !== expectedOuterWatermark) {
						providerRequestsDenied += 1;
						journal.append(
							{
								runId,
								attemptId,
								kind: "provider_denied",
								body: { reason: "watermarkMismatch", expected: expectedOuterWatermark, got: msg.watermark },
							},
							nowMs(),
						);
						void terminatePiAndGroups("Provider watermark mismatch", "DeniedAndTerminated");
						return;
					}
					const payloadValidation = validateProviderPayload({
						payloadJson: msg.payloadJson,
						expectedModelId: modelId,
						expectedEncodedPrompt: encodedPromptText,
					});
					if (!payloadValidation.ok) {
						providerRequestsDenied += 1;
						journal.append(
							{
								runId,
								attemptId,
								kind: "provider_denied",
								body: { reason: payloadValidation.reason, seq: msg.seq },
							},
							nowMs(),
						);
						void terminatePiAndGroups(payloadValidation.reason, "DeniedAndTerminated");
						return;
					}

					const candCommit = journal.append(
						{
							runId,
							attemptId,
							kind: "provider_candidate",
							body: {
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
						void terminatePiAndGroups(`ProviderCandidate journal failed: ${candCommit.error}`, "InvalidEvidence");
						return;
					}

					const grantCommit = journal.append(
						{
							runId,
							attemptId,
							kind: "provider_grant",
							body: {
								seq: msg.seq,
								watermark: msg.watermark,
								payloadDigest: msg.payloadDigest,
								attemptsUsedSoFar: attemptOrdinal,
							},
						},
						nowMs(),
					);
					if (!grantCommit.ok) {
						providerRequestsDenied += 1;
						uncertified = true;
						void terminatePiAndGroups(`ProviderGrant journal failed before ACK: ${grantCommit.error}`, "InvalidEvidence");
						return;
					}

					const permit: PipeOuterToChild = {
						kind: "provider_permit",
						seq: msg.seq,
						attemptId,
						watermark: msg.watermark,
						payloadDigest: msg.payloadDigest,
					};

					if (request.faults?.injectMalformedPermitAck) {
						providerRequestsDenied += 1;
						pipeToAdapter.write('{"kind":"provider_permit","seq":999999,"bad":true}\n', "utf8");
						setTimeout(() => {
							void terminatePiAndGroups("Injected malformed permit ACK", "DeniedAndTerminated");
						}, 80);
						return;
					}
					if (request.faults?.injectReplayedPermitAck && lastPermitAck !== null) {
						providerRequestsDenied += 1;
						writeBoundedFrame(pipeToAdapter, lastPermitAck, UNIT1_LIMITS.controlFrameBytes);
						setTimeout(() => {
							void terminatePiAndGroups("Injected replayed permit ACK", "DeniedAndTerminated");
						}, 80);
						return;
					}

					lastPermitAck = permit;
					expectedOuterWatermark = msg.seq;
					providerRequestsGranted += 1;
					writeBoundedFrame(pipeToAdapter, permit, UNIT1_LIMITS.controlFrameBytes);

					if (request.faults?.injectJournalFailAfterGrant) {
						journal.setFailOnKind("tool_declared_batch");
					}
					const permitSentCommit = journal.append(
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
						void terminatePiAndGroups(`Journal failed after grant: ${permitSentCommit.error}`, "InvalidEvidence");
					}
					break;
				}
				case "tool_start_observe": {
					if (admissionClosed) {
						journal.append(
							{ runId, attemptId, kind: "tool_start_denied", body: { reason: "admissionClosed", callId: msg.callId } },
							nowMs(),
						);
						void terminatePiAndGroups("Tool start after admission closed", "DeniedAndTerminated");
						return;
					}
					if (seenStartedCallIds.has(msg.callId)) {
						journal.append(
							{ runId, attemptId, kind: "tool_start_denied", body: { reason: "duplicateCallId", callId: msg.callId } },
							nowMs(),
						);
						void terminatePiAndGroups(`Duplicate tool callId at start: ${msg.callId}`, "DeniedAndTerminated");
						return;
					}
					seenStartedCallIds.add(msg.callId);
					attemptOrdinal += 1;
					if (attemptOrdinal > UNIT1_LIMITS.maxAttempts) {
						admissionClosed = true;
						journal.append(
							{
								runId,
								attemptId,
								kind: "tool_start_denied",
								body: {
									reason: "attemptBudgetExceeded",
									ordinal: attemptOrdinal,
									maxAttempts: UNIT1_LIMITS.maxAttempts,
									callId: msg.callId,
									toolName: msg.toolName,
								},
							},
							nowMs(),
						);
						const existingDeclared = declaredToolCalls.find((d) => d.id === msg.callId);
						if (existingDeclared) {
							(existingDeclared as { ordinal: number | null }).ordinal = attemptOrdinal;
						}
						void terminatePiAndGroups(
							`Attempt budget exceeded at ordinal ${attemptOrdinal} (${msg.toolName})`,
							"DeniedAndTerminated",
						);
						return;
					}
					reservedCallOrdinals.set(msg.callId, attemptOrdinal);
					const existingDeclared = declaredToolCalls.find((d) => d.id === msg.callId);
					if (existingDeclared) {
						(existingDeclared as { ordinal: number | null }).ordinal = attemptOrdinal;
					}
					const reserveCommit = journal.append(
						{
							runId,
							attemptId,
							kind: "tool_start_reserved",
							body: { ordinal: attemptOrdinal, callId: msg.callId, toolName: msg.toolName },
						},
						nowMs(),
					);
					if (!reserveCommit.ok) {
						uncertified = true;
						void terminatePiAndGroups(`Tool start reserve failed: ${reserveCommit.error}`, "InvalidEvidence");
						return;
					}
					expectedOuterWatermark = msg.seq;
					writeBoundedFrame(
						pipeToAdapter,
						{
							kind: "tool_start_ack",
							seq: msg.seq,
							callId: msg.callId,
							allowed: true,
							ordinal: attemptOrdinal,
						} satisfies PipeOuterToChild,
						UNIT1_LIMITS.controlFrameBytes,
					);
					break;
				}
				case "tool_execute": {
					const ordinal = reservedCallOrdinals.get(msg.callId);
					if (ordinal === undefined || ordinal > UNIT1_LIMITS.maxAttempts || admissionClosed) {
						void terminatePiAndGroups(`Unauthorized tool_execute for callId=${msg.callId}`, "DeniedAndTerminated");
						return;
					}
					nativeQueue = nativeQueue.then(async () => {
						if (admissionClosed || nativeAbort.signal.aborted) return;
						const leaseId = makeGroupLeaseId(`lease-${ordinal}`);
						const execPath = request.faults?.nativeExecOverride ?? closureBefore.nativePin.canonicalPath;
						const argv = request.faults?.nativeArgsOverride
							? request.faults.nativeArgsOverride.map((arg) =>
									arg === "__PI_PID__" ? String(piChild?.pid ?? -1) : arg,
							  )
							: ["--data-dir", dataDir, "--offline", "--json", "status"];

						const outcome = await runRegisteredNativeGroup({
							registry,
							leaseId,
							runId,
							attemptId,
							captureDir,
							dataDir,
							cwd,
							execPath,
							argv,
							helperPath: request.faults?.helperPathOverride,
							nativeSentinelPath: request.faults?.nativeSentinelPath,
							journal,
							monotonicStartMs,
							deadlineMs: request.faults?.nativeDeadlineMsOverride ?? UNIT1_LIMITS.nativeDeadlineMs,
							abortSignal: nativeAbort.signal,
							skipGoAndCloseHelper: request.faults?.injectSkipGoAndCloseHelper,
							onKillPiBetweenRegAndGo: request.faults?.injectKillPiBetweenRegAndGo
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
							onNativeFirstChunk: request.faults?.injectKillPiDuringNativeOutput
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
							onOverflow: (stream, observedBytes) => {
								uncertified = true;
								journal.append(
									{
										runId,
										attemptId,
										kind: "overflow_uncertified",
										body: { stream, observedBytes },
									},
									nowMs(),
									true,
								);
							},
							onSinkFailure: (stream, err) => {
								uncertified = true;
								journal.append(
									{
										runId,
										attemptId,
										kind: "journal_fault",
										body: { stream, error: err.message },
									},
									nowMs(),
									true,
								);
							},
							sinkStallMs: request.faults?.simulatedSinkStallMs,
							injectPsFailure: request.faults?.injectPsFailure,
						});
						if (outcome.nativeStarted) {
							nativeStarts += 1;
						}

						if (admissionClosed || piExited) {
							return;
						}

						const toolResultText = outcome.ok
							? outcome.stdoutText
							: JSON.stringify({ ok: false, error: outcome.errorMessage ?? outcome.stderrText });

						journal.append(
							{
								runId,
								attemptId,
								kind: "tool_result_delivered",
								body: {
									leaseId,
									callId: msg.callId,
									isError: !outcome.ok,
									stdoutBytes: Buffer.byteLength(outcome.stdoutText, "utf8"),
									stderrBytes: Buffer.byteLength(outcome.stderrText, "utf8"),
								},
							},
							nowMs(),
						);

						writeBoundedFrame(
							pipeToAdapter,
							{
								kind: "tool_result",
								seq: msg.seq,
								callId: msg.callId,
								isError: !outcome.ok,
								text: toolResultText,
							} satisfies PipeOuterToChild,
							UNIT1_LIMITS.controlFrameBytes,
						);
					});
					break;
				}
			}
		},
	});

	const caseDeadlineMs = request.faults?.caseDeadlineMsOverride ?? UNIT1_LIMITS.caseDeadlineMs;
	const caseTimer = setTimeout(() => {
		void terminatePiAndGroups(`Case deadline ${caseDeadlineMs} ms exceeded`, "DeniedAndTerminated");
	}, caseDeadlineMs);
	caseTimer.unref();

	try {
		if (request.faults?.injectKillPiBeforeReady && typeof piChild.pid === "number") {
			try {
				process.kill(piChild.pid, "SIGKILL");
			} catch {
				// Ignore
			}
		}

		if (!request.faults?.bypassReadyCheck) {
			const startupTimeoutMs = request.faults?.startupTimeoutMsOverride ?? UNIT1_LIMITS.startupTimeoutMs;
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
				} else if (piExited) {
					clearTimeout(timer);
					resolveStartupWait = null;
					res({ ok: false, reason: `Pi exited before BoundReady (code=${String(piExitCode)})` });
				}
			});
			if (!readyOk.ok) {
				await terminatePiAndGroups(readyOk.reason ?? "Startup readiness failed", "PreWorkInfrastructureFailed");
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
			if (piExited) {
				clearTimeout(timer);
				pendingGetStateResolve = null;
				res(null);
				return;
			}
			writeBoundedFrame(rpcIn, { id: "state-1", type: "get_state" }, UNIT1_LIMITS.controlFrameBytes);
		});

		if (!getStateRes || getStateRes.success !== true) {
			const reason = `get_state failed or timed out: ${JSON.stringify(getStateRes)}`;
			await terminatePiAndGroups(reason, "PreWorkInfrastructureFailed");
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
			await terminatePiAndGroups(reason, "PreWorkInfrastructureFailed");
			throw new Error(reason);
		}

		const stateCommit = journal.append(
			{
				runId,
				attemptId,
				kind: "get_state_ok",
				body: {
					modelProvider: stateModel?.provider,
					modelId: stateModel?.id,
					thinkingLevel: stateData.thinkingLevel,
					autoCompactionEnabled: stateData.autoCompactionEnabled,
				},
			},
			nowMs(),
		);
		if (!stateCommit.ok) {
			uncertified = true;
			await terminatePiAndGroups(`get_state journal failed: ${stateCommit.error}`, "InvalidEvidence");
			throw new Error(stateCommit.error);
		}

		const promptEncodeCommit = journal.append(
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
			await terminatePiAndGroups(`prompt_encoded journal failed: ${promptEncodeCommit.error}`, "InvalidEvidence");
			throw new Error(promptEncodeCommit.error);
		}

		promptReceived = true;
		journal.append({ runId, attemptId, kind: "prompt_sent", body: { id: "prompt-1" } }, nowMs());
		writeBoundedFrame(
			rpcIn,
			{ id: "prompt-1", type: "prompt", message: encodedPromptText },
			UNIT1_LIMITS.controlFrameBytes,
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
				writeBoundedFrame(rpcIn, { id: "state-end", type: "get_state" }, UNIT1_LIMITS.controlFrameBytes);
			});
			const idleData = (idleRes?.data ?? {}) as Record<string, unknown>;
			const isIdle =
				idleRes?.success === true &&
				idleData.isStreaming === false &&
				idleData.isCompacting === false &&
				idleData.pendingMessageCount === 0;

			rpcIn.end();
			await new Promise<void>((res) => {
				if (piExited) {
					res();
					return;
				}
				const t = setTimeout(() => {
					piExitResolve = null;
					res();
				}, UNIT1_LIMITS.killGraceMs);
				piExitResolve = () => {
					clearTimeout(t);
					piExitResolve = null;
					res();
				};
			});

			if (!piExited) {
				await terminatePiAndGroups("Pi did not exit cleanly after RPC stdin EOF", "TaskFailed");
			} else if (
				promptPreflightSeen &&
				promptPreflightDisposition === "started" &&
				isIdle &&
				terminalAssistantStopReason === "stop" &&
				answerText !== null &&
				answerText.length > 0 &&
				!uncertified &&
				!piOverflowed &&
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
			await terminatePiAndGroups("Pi exited unexpectedly before agent_settled", "DeniedAndTerminated");
		}
	} catch (err) {
		if (!stopTerminationStarted) {
			await terminatePiAndGroups(err instanceof Error ? err.message : String(err), status);
		}
	} finally {
		clearTimeout(caseTimer);
		if (terminationPromise !== null) {
			await terminationPromise;
		} else {
			await registry.stopAll({
				journal,
				runId,
				attemptId,
				injectPsFailure: request.faults?.injectPsFailure,
				omitTeardownForTesting: request.faults?.injectOmitNativeTeardown,
			});
		}
		if (piChild && typeof piChild.pid === "number" && !piExited) {
			await terminatePiAndGroups(failureReason ?? "Cleanup at end", status);
		}
		detachRpcReader();
		detachAdapterReader();
		piStdoutSink.close();
		piStderrSink.close();

		if (request.faults?.bypassReadyCheck || !boundReadySeen || piOverflowed || journal.hasFailed) {
			uncertified = true;
		}
		for (const g of registry.entries.values()) {
			if (g.state === "Unknown" || g.closure?.kind === "unknown" || g.closure?.kind === "alive") {
				uncertified = true;
			}
		}

		journal.append(
			{
				runId,
				attemptId,
				kind: "attempt_closed",
				body: { status, failureReason, uncertified, nativeStarts, providerRequestsGranted, providerRequestsDenied },
			},
			nowMs(),
			true,
		);
		journal.close();
	}

	const closureAfter = options?.cachedClosure ? closureBefore : captureExecutionClosure();

	const groupObservations = Array.from(registry.entries.values()).map((entry) => ({
		leaseId: entry.leaseId,
		state: entry.state,
		pgid: entry.pgid,
		helperPid: entry.helperPid,
		nativePid: entry.nativePid,
		registeredBeforeGo: entry.registeredBeforeGo,
		sentinelAbsentAtRegistration: entry.sentinelAbsentAtRegistration,
		killEscalationMs: entry.killEscalationMs,
		closure: entry.closure,
	}));

	const result: ProofRunResult = {
		certificateNotice: UNIT1_LIMITS.certificateNotice,
		toolProfile: UNIT1_LIMITS.toolProfile,
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
		piExitCode,
		piSignal,
		uncertified,
		rawArtifacts: { journalPath, piStdoutPath, piStderrPath },
		closureBeforeSha256: closureBefore.closureDigest,
		closureAfterSha256: closureAfter.closureDigest,
	};

	writeExclusiveFile(indexEntryPath, JSON.stringify(result, null, 2));
	return result;
}

function sleepMs(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}
