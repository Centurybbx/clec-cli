import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { runUnit1Proof } from "./controller.ts";
import {
	writeBypassGoHelperFixture,
	writeFaultAdapterFixture,
	writeFaultBinary,
	writeLeaderExitSurvivingChildHelper,
	startUnit1LoopbackOpenAI,
	type RecordedLoopbackRequest,
} from "./fixtures.ts";
import { BoundedJournalWriter, createExclusiveDir, writeExclusiveFile } from "./framing.ts";
import { captureExecutionClosure, sha256Buffer, sha256FileStreaming } from "./pins.ts";
import { observeGroupInProcessTable } from "./process-group.ts";
import { makeAttemptId, makeRunId, type ProofRunResult, UNIT1_LIMITS } from "./types.ts";

interface MatrixCaseOutcome {
	readonly id: string;
	readonly category:
		| "startup"
		| "literal_input"
		| "admission"
		| "budget"
		| "before_go"
		| "after_go"
		| "observation"
		| "ownership_and_bounds";
	readonly polarity: "positive" | "negative" | "control_sensitivity";
	readonly passed: boolean;
	readonly detail: string;
	readonly elapsedMs: number;
	readonly status: string;
	readonly failureReason: string | null;
	readonly serverRequestsObserved: number;
	readonly nativeStartsObserved: number;
	readonly bundleDir: string | null;
	readonly indexEntryPath: string | null;
	readonly extraEvidence?: Record<string, unknown>;
}

function assert(cond: boolean, message: string): asserts cond {
	if (!cond) {
		throw new Error(`Assertion failed: ${message}`);
	}
}

function extractFirstUserPromptFromLoopback(req: RecordedLoopbackRequest): string | null {
	const messages = req.bodyJson.messages;
	if (!Array.isArray(messages)) return null;
	const user = messages.find((m) => m && typeof m === "object" && (m as Record<string, unknown>).role === "user") as
		| Record<string, unknown>
		| undefined;
	if (!user) return null;
	if (typeof user.content === "string") return user.content;
	if (Array.isArray(user.content) && user.content.length === 1) {
		const b = user.content[0] as Record<string, unknown>;
		if (b?.type === "text" && typeof b.text === "string") return b.text;
	}
	return null;
}

function readGitMetadata(): { readonly head: string; readonly dirtyStatus: string[] } {
	try {
		const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		const statusOut = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
		const dirtyStatus = statusOut
			.split("\n")
			.map((l) => l.trimEnd())
			.filter((l) => l.length > 0);
		return { head, dirtyStatus };
	} catch (err) {
		return { head: "unknown", dirtyStatus: [`git_error:${err instanceof Error ? err.message : String(err)}`] };
	}
}

async function runCase(
	id: string,
	category: MatrixCaseOutcome["category"],
	polarity: MatrixCaseOutcome["polarity"],
	fn: () => Promise<{
		readonly detail: string;
		readonly result?: ProofRunResult;
		readonly serverRequests?: readonly RecordedLoopbackRequest[];
		readonly nativeStarts?: number;
		readonly extraEvidence?: Record<string, unknown>;
	}>,
): Promise<MatrixCaseOutcome> {
	const t0 = performance.now();
	try {
		const out = await fn();
		return {
			id,
			category,
			polarity,
			passed: true,
			detail: out.detail,
			elapsedMs: Math.round(performance.now() - t0),
			status: out.result?.status ?? "OK",
			failureReason: out.result?.failureReason ?? null,
			serverRequestsObserved: out.serverRequests?.length ?? 0,
			nativeStartsObserved: out.nativeStarts ?? out.result?.nativeStarts ?? 0,
			bundleDir: out.result?.bundleDir ?? null,
			indexEntryPath: out.result?.indexEntryPath ?? null,
			extraEvidence: out.extraEvidence,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			id,
			category,
			polarity,
			passed: false,
			detail: msg,
			elapsedMs: Math.round(performance.now() - t0),
			status: "ASSERTION_FAILED",
			failureReason: msg,
			serverRequestsObserved: 0,
			nativeStartsObserved: 0,
			bundleDir: null,
			indexEntryPath: null,
		};
	}
}

function parseCliArgs(argv: readonly string[]): { readonly outParentDir: string; readonly caseFilter: string | null } {
	let outParentDir = resolve(import.meta.dirname, "../../../../.cache/phase6b-unit1");
	let caseFilter: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--out-parent" && i + 1 < argv.length) {
			outParentDir = resolve(argv[++i]);
		} else if (argv[i] === "--case" && i + 1 < argv.length) {
			caseFilter = argv[++i];
		}
	}
	return { outParentDir, caseFilter };
}

async function main(): Promise<void> {
	const { outParentDir, caseFilter } = parseCliArgs(process.argv.slice(2));
	mkdirSync(outParentDir, { recursive: true });
	const matrixRunId = `matrix-${Date.now()}-${randomBytes(4).toString("hex")}`;
	const matrixDir = join(outParentDir, matrixRunId);
	const evidenceParentDir = join(matrixDir, "evidence");
	const fixturesDir = join(matrixDir, "test-fixtures");
	createExclusiveDir(matrixDir);
	createExclusiveDir(evidenceParentDir);
	createExclusiveDir(fixturesDir);

	const gitMeta = readGitMetadata();
	const closureBefore = captureExecutionClosure();

	const cases: Array<() => Promise<MatrixCaseOutcome>> = [];
	const add = (
		id: string,
		category: MatrixCaseOutcome["category"],
		polarity: MatrixCaseOutcome["polarity"],
		fn: () => Promise<{
			readonly detail: string;
			readonly result?: ProofRunResult;
			readonly serverRequests?: readonly RecordedLoopbackRequest[];
			readonly nativeStarts?: number;
			readonly extraEvidence?: Record<string, unknown>;
		}>,
	): void => {
		if (caseFilter && id !== caseFilter) return;
		cases.push(() => runCase(id, category, polarity, fn));
	};

	add("startup_positive", "startup", "positive", async () => {
		const srv = await startUnit1LoopbackOpenAI(() => ({ kind: "text", text: "Startup verified." }));
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "startup_positive",
					evidenceParentDir,
					question: "Check startup.",
					mockBaseUrl: srv.baseUrl,
				},
				{ cachedClosure: closureBefore },
			);
			const journalText = readFileSync(res.rawArtifacts.journalPath, "utf8");
			const kinds = journalText
				.trim()
				.split("\n")
				.map((l) => (JSON.parse(l) as { kind: string }).kind);
			const idxBound = kinds.indexOf("bound_ready");
			const idxAck = kinds.indexOf("bound_ready_ack");
			const idxState = kinds.indexOf("get_state_ok");
			const idxPrompt = kinds.indexOf("prompt_sent");
			const idxSettled = kinds.indexOf("agent_settled");
			assert(res.status === "Answered", `expected Answered, got ${res.status} (${res.failureReason})`);
			assert(!res.uncertified, "positive startup must not be uncertified");
			assert(res.piExitCode === 0, `expected piExitCode 0, got ${String(res.piExitCode)}`);
			assert(srv.requests.length === 1, `expected 1 loopback request, got ${srv.requests.length}`);
			assert(idxBound >= 0 && idxAck > idxBound && idxState > idxAck && idxPrompt > idxState && idxSettled > idxPrompt, `unexpected event order: ${kinds.join(",")}`);
			return { detail: `Answered with exit 0; order=${kinds.join("->")}`, result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("startup_missing_extension", "startup", "negative", async () => {
		const srv = await startUnit1LoopbackOpenAI(() => ({ kind: "text", text: "FORBIDDEN" }));
		try {
			const missingPath = join(fixturesDir, "does-not-exist.ts");
			const res = await runUnit1Proof(
				{
					caseLabel: "startup_missing_extension",
					evidenceParentDir,
					question: "Should never send.",
					mockBaseUrl: srv.baseUrl,
					faults: { adapterPathOverride: missingPath, startupTimeoutMsOverride: 5_000 },
				},
				{ cachedClosure: closureBefore },
			);
			assert(res.status === "PreWorkInfrastructureFailed", `expected PreWorkInfrastructureFailed, got ${res.status}`);
			assert(!res.promptReceived, "prompt must not be sent");
			assert(srv.requests.length === 0, `expected 0 loopback requests, got ${srv.requests.length}`);
			return { detail: `Zero prompts/requests; reason=${res.failureReason}`, result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	for (const kind of ["import_failure", "setup_throw", "session_start_throw", "no_ready", "early_eof", "broken_channel"] as const) {
		add(`startup_${kind}`, "startup", "negative", async () => {
			const srv = await startUnit1LoopbackOpenAI(() => ({ kind: "text", text: "FORBIDDEN" }));
			try {
				const adapterPath = writeFaultAdapterFixture(fixturesDir, kind);
				const res = await runUnit1Proof(
					{
						caseLabel: `startup_${kind}`,
						evidenceParentDir,
						question: "Should never send.",
						mockBaseUrl: srv.baseUrl,
						faults: {
							adapterPathOverride: adapterPath,
							startupTimeoutMsOverride: 2_000,
						},
					},
					{ cachedClosure: closureBefore },
				);
				assert(!res.promptReceived, `${kind} must not send prompt`);
				assert(srv.requests.length === 0, `${kind} must yield 0 loopback requests, got ${srv.requests.length}`);
				assert(res.status !== "Answered", `${kind} must not answer`);
				return { detail: `Zero prompts/requests (${res.status}): ${res.failureReason}`, result: res, serverRequests: srv.requests };
			} finally {
				await srv.close();
			}
		});
	}

	add("startup_bypass_ready_sensitivity", "startup", "control_sensitivity", async () => {
		const srv = await startUnit1LoopbackOpenAI(() => ({ kind: "text", text: "Bypassed readiness." }));
		try {
			const adapterPath = writeFaultAdapterFixture(fixturesDir, "no_ready");
			const res = await runUnit1Proof(
				{
					caseLabel: "startup_bypass_ready_sensitivity",
					evidenceParentDir,
					question: "Bypassed readiness check.",
					mockBaseUrl: srv.baseUrl,
					faults: { adapterPathOverride: adapterPath, bypassReadyCheck: true },
				},
				{ cachedClosure: closureBefore },
			);
			const journalText = readFileSync(res.rawArtifacts.journalPath, "utf8");
			const hasBoundReady = journalText.includes('"kind":"bound_ready"');
			assert(res.promptReceived, "sensitivity driver must reach prompt");
			assert(!hasBoundReady, "journal must prove bound_ready is absent");
			assert(res.uncertified, "bypassed readiness run must be uncertified");
			assert(res.status !== "Answered", "bypassed readiness run must not certify as Answered");
			return {
				detail: `Detected missing bound_ready; uncertified=${res.uncertified}, mockReqs=${srv.requests.length}`,
				result: res,
				serverRequests: srv.requests,
			};
		} finally {
			await srv.close();
		}
	});

	const literalInputs: ReadonlyArray<{ readonly id: string; readonly question: string }> = [
		{ id: "literal_leading_slash", question: "/help /skill:clec /unknown-cmd" },
		{ id: "literal_json_looking", question: '{"id":"fake-rpc","type":"abort","command":"bash"}' },
		{ id: "literal_multiline", question: "first line\nsecond line\n/third-line" },
		{ id: "literal_at_file", question: "@README.md @/etc/passwd" },
	];

	for (const lit of literalInputs) {
		add(lit.id, "literal_input", "positive", async () => {
			const srv = await startUnit1LoopbackOpenAI(() => ({ kind: "text", text: "Literal verified." }));
			try {
				const res = await runUnit1Proof(
					{
						caseLabel: lit.id,
						evidenceParentDir,
						question: lit.question,
						mockBaseUrl: srv.baseUrl,
					},
					{ cachedClosure: closureBefore },
				);
				assert(res.status === "Answered", `expected Answered, got ${res.status}`);
				assert(srv.requests.length === 1, `expected 1 request, got ${srv.requests.length}`);
				const receivedPrompt = extractFirstUserPromptFromLoopback(srv.requests[0]);
				const expectedPrompt = `${UNIT1_LIMITS.promptPrefix}${lit.question}`;
				assert(
					receivedPrompt === expectedPrompt,
					`prompt mismatch: expected ${JSON.stringify(expectedPrompt)}, got ${JSON.stringify(receivedPrompt)}`,
				);
				assert(
					sha256Buffer(Buffer.from(receivedPrompt, "utf8")) === res.encodedPromptBytesSha256,
					"received prompt SHA-256 differs from committed encoded SHA-256",
				);
				return {
					detail: `Exact literal suffix received (${Buffer.byteLength(receivedPrompt, "utf8")} bytes)`,
					result: res,
					serverRequests: srv.requests,
					extraEvidence: { expectedPrompt, receivedPrompt },
				};
			} finally {
				await srv.close();
			}
		});
	}

	add("literal_altered_encoder_sensitivity", "literal_input", "control_sensitivity", async () => {
		const srv = await startUnit1LoopbackOpenAI(() => ({ kind: "text", text: "Altered." }));
		try {
			const question = "/help literal";
			const res = await runUnit1Proof(
				{
					caseLabel: "literal_altered_encoder_sensitivity",
					evidenceParentDir,
					question,
					mockBaseUrl: srv.baseUrl,
					faults: {
						alterPromptEncoder: (q) => q,
					},
				},
				{ cachedClosure: closureBefore },
			);
			assert(srv.requests.length === 1, "altered encoder should still run startup cleanly to test byte comparison");
			const receivedPrompt = extractFirstUserPromptFromLoopback(srv.requests[0]);
			const canonicalExpected = `${UNIT1_LIMITS.promptPrefix}${question}`;
			assert(receivedPrompt !== canonicalExpected, "altered encoder must produce predicted byte mismatch");
			assert(receivedPrompt === question, "expected unprefixed bytes");
			return {
				detail: `Predicted byte mismatch detected: received=${JSON.stringify(receivedPrompt)} vs canonical=${JSON.stringify(canonicalExpected)}`,
				result: res,
				serverRequests: srv.requests,
				extraEvidence: { canonicalExpected, receivedPrompt },
			};
		} finally {
			await srv.close();
		}
	});

	add("admission_valid", "admission", "positive", async () => {
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				return {
					kind: "tool_calls",
					calls: [{ id: "call_adm_1", name: "clec", rawArgumentsJson: '{"action":"status"}' }],
				};
			}
			return { kind: "text", text: "Admission valid." };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "admission_valid",
					evidenceParentDir,
					question: "Verify admission.",
					mockBaseUrl: srv.baseUrl,
				},
				{ cachedClosure: closureBefore },
			);
			assert(res.status === "Answered", `expected Answered, got ${res.status}`);
			assert(res.providerRequestsGranted === 2, `expected 2 grants, got ${res.providerRequestsGranted}`);
			assert(res.nativeStarts === 1, `expected 1 native start, got ${res.nativeStarts}`);
			assert(srv.requests.length === 2, `expected 2 requests, got ${srv.requests.length}`);
			const req0Tools = srv.requests[0].bodyJson.tools as Array<Record<string, unknown>>;
			assert(Array.isArray(req0Tools) && req0Tools.length === 1, "expected 1 tool in loopback request");
			return { detail: "2 grants committed before permit ACK, 1 native status run", result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	for (const kind of [
		"bash_drift",
		"schema_drift",
		"sync_serialization_err",
		"async_channel_reject",
		"eof_during_latch",
	] as const) {
		add(`admission_${kind}`, "admission", "negative", async () => {
			const srv = await startUnit1LoopbackOpenAI(() => ({ kind: "text", text: "FORBIDDEN" }));
			try {
				const adapterPath = writeFaultAdapterFixture(fixturesDir, kind);
				const res = await runUnit1Proof(
					{
						caseLabel: `admission_${kind}`,
						evidenceParentDir,
						question: "Check admission denial.",
						mockBaseUrl: srv.baseUrl,
						faults: {
							adapterPathOverride: adapterPath,
							caseDeadlineMsOverride: 2_500,
						},
					},
					{ cachedClosure: closureBefore },
				);
				assert(srv.requests.length === 0, `${kind} leaked ${srv.requests.length} forbidden loopback requests`);
				assert(res.status !== "Answered", `${kind} must not answer`);
				if (kind === "schema_drift") {
					assert(
						res.failureReason?.includes("CLEC tool schema drift") === true,
						`schema_drift expected schema drift reason, got ${res.failureReason}`,
					);
				}
				return { detail: `0 loopback requests; status=${res.status} (${res.failureReason})`, result: res, serverRequests: srv.requests };
			} finally {
				await srv.close();
			}
		});
	}

	add("admission_record_fail_before_grant", "admission", "negative", async () => {
		const srv = await startUnit1LoopbackOpenAI(() => ({ kind: "text", text: "FORBIDDEN" }));
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "admission_record_fail_before_grant",
					evidenceParentDir,
					question: "Record fail before grant.",
					mockBaseUrl: srv.baseUrl,
					faults: { injectJournalFailOnKind: "provider_grant" },
				},
				{ cachedClosure: closureBefore },
			);
			assert(srv.requests.length === 0, `expected 0 requests, got ${srv.requests.length}`);
			assert(res.uncertified, "journal fail before grant must be uncertified");
			assert(res.status === "InvalidEvidence", `expected InvalidEvidence, got ${res.status}`);
			return { detail: `0 loopback requests; killed cleanly (${res.failureReason})`, result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("admission_record_fail_after_grant", "admission", "negative", async () => {
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				return {
					kind: "tool_calls",
					calls: [{ id: "call_after_grant", name: "clec", rawArgumentsJson: '{"action":"status"}' }],
				};
			}
			return { kind: "text", text: "FORBIDDEN_SECOND" };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "admission_record_fail_after_grant",
					evidenceParentDir,
					question: "Record fail after grant.",
					mockBaseUrl: srv.baseUrl,
					faults: { injectJournalFailAfterGrant: true },
				},
				{ cachedClosure: closureBefore },
			);
			assert(srv.requests.length === 1, `later fail cannot unsend already-granted request 1, got ${srv.requests.length}`);
			assert(res.nativeStarts === 0, `post-grant failure must prevent native start, got ${res.nativeStarts}`);
			assert(res.uncertified, "record fail after grant must invalidate evidence");
			assert(res.status === "InvalidEvidence", `expected InvalidEvidence, got ${res.status}`);
			return { detail: `Observed ${srv.requests.length} already-granted request, closed further admission, InvalidEvidence`, result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("admission_malformed_ack", "admission", "negative", async () => {
		const srv = await startUnit1LoopbackOpenAI(() => ({ kind: "text", text: "FORBIDDEN" }));
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "admission_malformed_ack",
					evidenceParentDir,
					question: "Malformed ack.",
					mockBaseUrl: srv.baseUrl,
					faults: { injectMalformedPermitAck: true },
				},
				{ cachedClosure: closureBefore },
			);
			assert(srv.requests.length === 0, `expected 0 requests, got ${srv.requests.length}`);
			assert(res.status === "DeniedAndTerminated", `expected DeniedAndTerminated, got ${res.status}`);
			return { detail: "Malformed permit ACK kept latch pending; 0 loopback requests", result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("admission_replayed_ack", "admission", "negative", async () => {
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				return {
					kind: "tool_calls",
					calls: [{ id: "call_r1", name: "clec", rawArgumentsJson: '{"action":"status"}' }],
				};
			}
			return { kind: "text", text: "FORBIDDEN_REPLAYED" };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "admission_replayed_ack",
					evidenceParentDir,
					question: "Replayed ack.",
					mockBaseUrl: srv.baseUrl,
					faults: { injectReplayedPermitAck: true },
				},
				{ cachedClosure: closureBefore },
			);
			assert(srv.requests.length === 1, `expected 1 request before replay on turn 2, got ${srv.requests.length}`);
			assert(res.status === "DeniedAndTerminated", `expected DeniedAndTerminated, got ${res.status}`);
			return { detail: "Turn 2 replayed permit ACK rejected by adapter latch; 0 turn-2 requests", result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("admission_unprotected_guard_sensitivity", "admission", "control_sensitivity", async () => {
		const srv = await startUnit1LoopbackOpenAI(() => ({ kind: "text", text: "UNPROTECTED_REACHED_LOOPBACK" }));
		try {
			const adapterPath = writeFaultAdapterFixture(fixturesDir, "unprotected_guard");
			const res = await runUnit1Proof(
				{
					caseLabel: "admission_unprotected_guard_sensitivity",
					evidenceParentDir,
					question: "Unprotected guard check.",
					mockBaseUrl: srv.baseUrl,
					faults: { adapterPathOverride: adapterPath },
				},
				{ cachedClosure: closureBefore },
			);
			assert(srv.requests.length === 1, `expected forbidden request to reach loopback when guard disabled, got ${srv.requests.length}`);
			return {
				detail: `Unprotected guard allowed 1 request to loopback (mockReqs=${srv.requests.length})`,
				result: res,
				serverRequests: srv.requests,
			};
		} finally {
			await srv.close();
		}
	});

	add("budget_8_valid_plus_answer", "budget", "positive", async () => {
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq <= 8) {
				return {
					kind: "tool_calls",
					calls: [{ id: `call_v_${req.seq}`, name: "clec", rawArgumentsJson: '{"action":"status"}' }],
				};
			}
			return { kind: "text", text: "Eight calls completed and answered." };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "budget_8_valid_plus_answer",
					evidenceParentDir,
					question: "Run 8 status calls then answer.",
					mockBaseUrl: srv.baseUrl,
				},
				{ cachedClosure: closureBefore },
			);
			assert(res.status === "Answered", `expected Answered, got ${res.status} (${res.failureReason})`);
			assert(res.nativeStarts === 8, `expected 8 native starts, got ${res.nativeStarts}`);
			assert(srv.requests.length === 9, `expected 9 provider requests (8 tool + 1 answer), got ${srv.requests.length}`);
			assert(res.groupObservations.length === 8 && res.groupObservations.every((g) => g.state === "Closed"), "all 8 native groups must close");
			return { detail: "8 serial real clec.exe runs + final answer succeeded", result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("budget_8_invalid_then_9th_valid", "budget", "negative", async () => {
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				const calls = [];
				for (let i = 1; i <= 8; i++) {
					calls.push({ id: `call_inv_${i}`, name: "clec", rawArgumentsJson: '{"action":"bogus"}' });
				}
				calls.push({ id: "call_valid_9", name: "clec", rawArgumentsJson: '{"action":"status"}' });
				return { kind: "tool_calls", calls };
			}
			return { kind: "text", text: "FORBIDDEN_EXTRA" };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "budget_8_invalid_then_9th_valid",
					evidenceParentDir,
					question: "8 schema-invalid then 9th valid.",
					mockBaseUrl: srv.baseUrl,
				},
				{ cachedClosure: closureBefore },
			);
			assert(res.nativeStarts === 0, `expected 0 native starts, got ${res.nativeStarts}`);
			assert(srv.requests.length === 1, `expected 1 provider request total, got ${srv.requests.length}`);
			assert(res.status === "DeniedAndTerminated", `expected DeniedAndTerminated, got ${res.status}`);
			return { detail: "8 schema-invalid calls consumed budget; 9th valid denied with 0 native starts", result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("budget_8_valid_then_9th_unknown", "budget", "negative", async () => {
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq <= 8) {
				return {
					kind: "tool_calls",
					calls: [{ id: `call_vu_${req.seq}`, name: "clec", rawArgumentsJson: '{"action":"status"}' }],
				};
			}
			if (req.seq === 9) {
				return {
					kind: "tool_calls",
					calls: [{ id: "call_unk_9", name: "unknown_tool_9", rawArgumentsJson: "{}" }],
				};
			}
			return { kind: "text", text: "FORBIDDEN_EXTRA" };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "budget_8_valid_then_9th_unknown",
					evidenceParentDir,
					question: "8 valid then 9th unknown.",
					mockBaseUrl: srv.baseUrl,
				},
				{ cachedClosure: closureBefore },
			);
			assert(res.nativeStarts === 8, `expected 8 native starts, got ${res.nativeStarts}`);
			assert(srv.requests.length === 9, `expected 9 requests (no extra provider req after 9th denial), got ${srv.requests.length}`);
			assert(res.status === "DeniedAndTerminated", `expected DeniedAndTerminated, got ${res.status}`);
			return { detail: "8 native starts; 9th unknown denied at tool_execution_start with 0 extra HTTP requests", result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("budget_duplicate_call_ids", "budget", "negative", async () => {
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				return {
					kind: "tool_calls",
					calls: [{ id: "dup_call_1", name: "clec", rawArgumentsJson: '{"action":"status"}' }],
				};
			}
			if (req.seq === 2) {
				return {
					kind: "tool_calls",
					calls: [{ id: "dup_call_1", name: "clec", rawArgumentsJson: '{"action":"status"}' }],
				};
			}
			return { kind: "text", text: "FORBIDDEN" };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "budget_duplicate_call_ids",
					evidenceParentDir,
					question: "Duplicate call IDs.",
					mockBaseUrl: srv.baseUrl,
				},
				{ cachedClosure: closureBefore },
			);
			assert(res.status === "DeniedAndTerminated", `expected DeniedAndTerminated, got ${res.status}`);
			assert(res.nativeStarts === 1, `duplicate ID must not execute twice, got ${res.nativeStarts}`);
			assert(srv.requests.length === 2, `expected 2 provider requests (0 third), got ${srv.requests.length}`);
			return { detail: `Duplicate callId rejected explicitly (${res.failureReason})`, result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("budget_batch_terminated_early", "budget", "negative", async () => {
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				const calls = [];
				for (let i = 1; i <= 10; i++) {
					calls.push({ id: `batch_call_${i}`, name: "clec", rawArgumentsJson: '{"action":"status"}' });
				}
				return { kind: "tool_calls", calls };
			}
			return { kind: "text", text: "FORBIDDEN" };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "budget_batch_terminated_early",
					evidenceParentDir,
					question: "10 calls in one batch.",
					mockBaseUrl: srv.baseUrl,
				},
				{ cachedClosure: closureBefore },
			);
			assert(res.status === "DeniedAndTerminated", `expected DeniedAndTerminated, got ${res.status}`);
			assert(res.nativeStarts === 8, `expected 8 native starts, got ${res.nativeStarts}`);
			assert(res.declaredToolCalls.length === 10, `expected all 10 declared calls recorded, got ${res.declaredToolCalls.length}`);
			assert(srv.requests.length === 1, `expected 1 provider request, got ${srv.requests.length}`);
			return { detail: `Recorded all 10 declared calls; executed 8, denied 9th, 10th unexecuted`, result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("before_go_registered_then_go", "before_go", "positive", async () => {
		const sentinelPath = join(fixturesDir, "sentinel-before-go.txt");
		const sentinelBin = writeFaultBinary(
			fixturesDir,
			"sentinel-native.mjs",
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinelPath)}, "executed-after-go\\n", "utf8");
process.stdout.write(JSON.stringify({ ok: true, sentinel: true }) + "\\n");
process.exit(0);`,
		);
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				return { kind: "tool_calls", calls: [{ id: "bg_1", name: "clec", rawArgumentsJson: '{"action":"status"}' }] };
			}
			return { kind: "text", text: "Sentinel created after GO." };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "before_go_registered_then_go",
					evidenceParentDir,
					question: "Test register before GO.",
					mockBaseUrl: srv.baseUrl,
					faults: {
						nativeExecOverride: sentinelBin,
						nativeArgsOverride: [],
						nativeSentinelPath: sentinelPath,
					},
				},
				{ cachedClosure: closureBefore },
			);
			assert(res.status === "Answered", `expected Answered, got ${res.status}`);
			assert(res.groupObservations[0]?.sentinelAbsentAtRegistration === true, "sentinel must be absent at GroupRegistered");
			assert(res.groupObservations[0]?.registeredBeforeGo === true, "registeredBeforeGo must be true");
			assert(existsSync(sentinelPath), "sentinel must exist after GO");
			return { detail: "GroupRegistered committed while sentinel absent; GO permitted sentinel creation", result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("before_go_reg_write_fail", "before_go", "negative", async () => {
		const sentinelPath = join(fixturesDir, "sentinel-reg-fail.txt");
		const sentinelBin = writeFaultBinary(
			fixturesDir,
			"sentinel-reg-fail.mjs",
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinelPath)}, "SHOULD_NOT_RUN\\n", "utf8");`,
		);
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				return { kind: "tool_calls", calls: [{ id: "bg_rf", name: "clec", rawArgumentsJson: '{"action":"status"}' }] };
			}
			return { kind: "text", text: "FORBIDDEN" };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "before_go_reg_write_fail",
					evidenceParentDir,
					question: "Reg write fail.",
					mockBaseUrl: srv.baseUrl,
					faults: {
						nativeExecOverride: sentinelBin,
						nativeArgsOverride: [],
						nativeSentinelPath: sentinelPath,
						injectJournalFailOnKind: "group_registered",
					},
				},
				{ cachedClosure: closureBefore },
			);
			assert(!existsSync(sentinelPath), "sentinel must stay absent when GroupRegistered write fails");
			assert(res.uncertified, "journal fail must mark uncertified");
			return { detail: "Registration write failure prevented GO; sentinel absent", result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("before_go_eof", "before_go", "negative", async () => {
		const sentinelPath = join(fixturesDir, "sentinel-eof.txt");
		const sentinelBin = writeFaultBinary(
			fixturesDir,
			"sentinel-eof.mjs",
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinelPath)}, "SHOULD_NOT_RUN\\n", "utf8");`,
		);
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				return { kind: "tool_calls", calls: [{ id: "bg_eof", name: "clec", rawArgumentsJson: '{"action":"status"}' }] };
			}
			return { kind: "text", text: "FORBIDDEN" };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "before_go_eof",
					evidenceParentDir,
					question: "EOF before GO.",
					mockBaseUrl: srv.baseUrl,
					faults: {
						nativeExecOverride: sentinelBin,
						nativeArgsOverride: [],
						nativeSentinelPath: sentinelPath,
						injectSkipGoAndCloseHelper: true,
					},
				},
				{ cachedClosure: closureBefore },
			);
			assert(!existsSync(sentinelPath), "sentinel must stay absent on EOF before GO");
			assert(res.groupObservations[0]?.state === "Closed", "waiting helper group must close cleanly");
			return { detail: "EOF before GO closed helper without executing native; sentinel absent", result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("before_go_pi_death_before_ready", "before_go", "negative", async () => {
		const sentinelPath = join(fixturesDir, "sentinel-pi-pre-ready.txt");
		const sentinelBin = writeFaultBinary(
			fixturesDir,
			"sentinel-pi-pre.mjs",
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinelPath)}, "SHOULD_NOT_RUN\\n", "utf8");`,
		);
		const srv = await startUnit1LoopbackOpenAI(() => ({ kind: "text", text: "FORBIDDEN" }));
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "before_go_pi_death_before_ready",
					evidenceParentDir,
					question: "Kill Pi before ready.",
					mockBaseUrl: srv.baseUrl,
					faults: {
						nativeExecOverride: sentinelBin,
						nativeArgsOverride: [],
						nativeSentinelPath: sentinelPath,
						injectKillPiBeforeReady: true,
					},
				},
				{ cachedClosure: closureBefore },
			);
			assert(!existsSync(sentinelPath), "sentinel must stay absent");
			assert(srv.requests.length === 0, "0 requests when Pi dies before BoundReady");
			return { detail: "Pi SIGKILL before BoundReady left sentinel absent and 0 requests", result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("before_go_pi_death_between_reg_and_go", "before_go", "negative", async () => {
		const sentinelPath = join(fixturesDir, "sentinel-pi-reg-go.txt");
		const sentinelBin = writeFaultBinary(
			fixturesDir,
			"sentinel-pi-rg.mjs",
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinelPath)}, "SHOULD_NOT_RUN\\n", "utf8");`,
		);
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				return { kind: "tool_calls", calls: [{ id: "bg_rg", name: "clec", rawArgumentsJson: '{"action":"status"}' }] };
			}
			return { kind: "text", text: "FORBIDDEN" };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "before_go_pi_death_between_reg_and_go",
					evidenceParentDir,
					question: "Kill Pi between GroupRegistered and GO.",
					mockBaseUrl: srv.baseUrl,
					faults: {
						nativeExecOverride: sentinelBin,
						nativeArgsOverride: [],
						nativeSentinelPath: sentinelPath,
						injectKillPiBetweenRegAndGo: true,
					},
				},
				{ cachedClosure: closureBefore },
			);
			assert(!existsSync(sentinelPath), "sentinel must stay absent when Pi dies between registration and GO");
			assert(res.nativeStarts === 0, `expected 0 native starts, got ${res.nativeStarts}`);
			assert(res.groupObservations[0]?.state === "Closed", "waiting helper group must be closed");
			return { detail: "Pi SIGKILL between registration and GO cleaned up waiting helper; sentinel absent", result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("before_go_bypass_gate_sensitivity", "before_go", "control_sensitivity", async () => {
		const sentinelPath = join(fixturesDir, "sentinel-bypass-go.txt");
		const bypassHelper = writeBypassGoHelperFixture(fixturesDir, sentinelPath);
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				return { kind: "tool_calls", calls: [{ id: "bg_byp", name: "clec", rawArgumentsJson: '{"action":"status"}' }] };
			}
			return { kind: "text", text: "Bypassed." };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "before_go_bypass_gate_sensitivity",
					evidenceParentDir,
					question: "Bypass GO gate.",
					mockBaseUrl: srv.baseUrl,
					faults: {
						helperPathOverride: bypassHelper,
						nativeSentinelPath: sentinelPath,
					},
				},
				{ cachedClosure: closureBefore },
			);
			assert(existsSync(sentinelPath), "bypass GO helper must create pre-registration sentinel");
			assert(res.groupObservations[0]?.sentinelAbsentAtRegistration === false, "controller must detect pre-registration sentinel");
			assert(res.groupObservations[0]?.registeredBeforeGo === false, "registeredBeforeGo must be false");
			return { detail: "Bypass-GO helper detected via sentinelAbsentAtRegistration=false", result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	const killerNativeBody = `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
const piPid = Number(process.argv[2]);
const marker = process.argv[3];
if (marker) writeFileSync(marker, String(process.pid), "utf8");
try { process.kill(piPid, "SIGKILL"); } catch {}
setInterval(() => {}, 1000);`;

	add("after_go_native_kills_pi_ignores_term", "after_go", "positive", async () => {
		const killerBin = writeFaultBinary(fixturesDir, "killer-native.mjs", killerNativeBody);
		const marker = join(fixturesDir, "killer-started.txt");
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				return { kind: "tool_calls", calls: [{ id: "ag_1", name: "clec", rawArgumentsJson: '{"action":"status"}' }] };
			}
			return { kind: "text", text: "FORBIDDEN" };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "after_go_native_kills_pi_ignores_term",
					evidenceParentDir,
					question: "Native kills Pi and ignores TERM.",
					mockBaseUrl: srv.baseUrl,
					faults: {
						nativeExecOverride: killerBin,
						nativeArgsOverride: ["__PI_PID__", marker],
					},
				},
				{ cachedClosure: closureBefore },
			);
			const g = res.groupObservations[0];
			assert(existsSync(marker), "fault native must have started");
			assert(g !== undefined && g.state === "Closed", `expected group Closed, got ${g?.state}`);
			assert(g.closure?.kind === "gone", `expected closure gone, got ${g.closure?.kind}`);
			assert(g.killEscalationMs !== null && g.killEscalationMs <= UNIT1_LIMITS.killGraceMs, `kill escalation took ${g.killEscalationMs}ms > 2000ms`);
			const directObs = await observeGroupInProcessTable({ pgid: g.pgid!, knownIdentities: [], monotonicStartMs: performance.now() });
			assert(directObs.kind === "gone", `direct ps verification failed: ${JSON.stringify(directObs)}`);
			return {
				detail: `Native killed explicit Pi PID & ignored SIGTERM; outer SIGKILLed PGID ${g.pgid} in ${g.killEscalationMs}ms; ps confirmed gone`,
				result: res,
				serverRequests: srv.requests,
			};
		} finally {
			await srv.close();
		}
	});

	add("after_go_omit_cleanup_sensitivity", "after_go", "control_sensitivity", async () => {
		const killerBin = writeFaultBinary(fixturesDir, "killer-omit.mjs", killerNativeBody);
		const marker = join(fixturesDir, "killer-omit-started.txt");
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				return { kind: "tool_calls", calls: [{ id: "ag_omit", name: "clec", rawArgumentsJson: '{"action":"status"}' }] };
			}
			return { kind: "text", text: "FORBIDDEN" };
		});
		let leakedPgid: number | null = null;
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "after_go_omit_cleanup_sensitivity",
					evidenceParentDir,
					question: "Omit cleanup sensitivity.",
					mockBaseUrl: srv.baseUrl,
					faults: {
						nativeExecOverride: killerBin,
						nativeArgsOverride: ["__PI_PID__", marker],
						injectOmitNativeTeardown: true,
					},
				},
				{ cachedClosure: closureBefore },
			);
			const g = res.groupObservations[0];
			leakedPgid = g?.pgid ?? null;
			assert(g?.closure?.kind === "alive", `expected alive survivor when teardown omitted, got ${g?.closure?.kind}`);
			assert(res.uncertified, "omitted teardown with survivor must be uncertified");
			return {
				detail: `Independently observed ${g.closure.survivors.length} surviving native in PGID ${leakedPgid}; test owner cleaned up`,
				result: res,
				serverRequests: srv.requests,
				extraEvidence: { survivors: g.closure.survivors },
			};
		} finally {
			if (leakedPgid !== null) {
				try {
					process.kill(-leakedPgid, "SIGKILL");
				} catch {
					// Ignore
				}
				const deadline = performance.now() + 2_000;
				while (performance.now() < deadline) {
					const obs = await observeGroupInProcessTable({ pgid: leakedPgid, knownIdentities: [], monotonicStartMs: performance.now() });
					if (obs.kind === "gone") break;
					await new Promise((r) => setTimeout(r, 30));
				}
			}
			await srv.close();
		}
	});

	add("after_go_leader_exit_surviving_child", "after_go", "positive", async () => {
		const leaderExitHelper = writeLeaderExitSurvivingChildHelper(fixturesDir);
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				return { kind: "tool_calls", calls: [{ id: "ag_le", name: "clec", rawArgumentsJson: '{"action":"status"}' }] };
			}
			return { kind: "text", text: "FORBIDDEN" };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "after_go_leader_exit_surviving_child",
					evidenceParentDir,
					question: "Helper leader exit with surviving child.",
					mockBaseUrl: srv.baseUrl,
					faults: {
						helperPathOverride: leaderExitHelper,
						nativeDeadlineMsOverride: 800,
					},
				},
				{ cachedClosure: closureBefore },
			);
			const g = res.groupObservations[0];
			assert(g !== undefined && g.state === "Closed", `expected group Closed after leader exit, got ${g?.state}`);
			assert(g.closure?.kind === "gone", `expected child in PGID gone, got ${g.closure?.kind}`);
			assert(g.killEscalationMs !== null && g.killEscalationMs <= UNIT1_LIMITS.killGraceMs, `escalation exceeded 2s: ${g.killEscalationMs}`);
			return { detail: `Helper leader exited early while child survived; outer killed PGID ${g.pgid} in ${g.killEscalationMs}ms`, result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("after_go_pi_death_during_output", "after_go", "positive", async () => {
		const noisyNative = writeFaultBinary(
			fixturesDir,
			"noisy-native.mjs",
			`process.on("SIGTERM", () => {});
setInterval(() => {
	process.stdout.write("chunk-" + "X".repeat(256) + "\\n");
}, 20);`,
		);
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				return { kind: "tool_calls", calls: [{ id: "ag_out", name: "clec", rawArgumentsJson: '{"action":"status"}' }] };
			}
			return { kind: "text", text: "FORBIDDEN" };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "after_go_pi_death_during_output",
					evidenceParentDir,
					question: "Pi death during native output.",
					mockBaseUrl: srv.baseUrl,
					faults: {
						nativeExecOverride: noisyNative,
						nativeArgsOverride: [],
						injectKillPiDuringNativeOutput: true,
					},
				},
				{ cachedClosure: closureBefore },
			);
			const g = res.groupObservations[0];
			assert(g !== undefined && g.state === "Closed", `expected Closed, got ${g?.state}`);
			assert(g.closure?.kind === "gone", `expected gone, got ${g.closure?.kind}`);
			assert(g.killEscalationMs !== null && g.killEscalationMs <= UNIT1_LIMITS.killGraceMs, `escalation exceeded 2s: ${g.killEscalationMs}`);
			return { detail: `Pi SIGKILL during output cleaned up streaming native PGID ${g.pgid} in ${g.killEscalationMs}ms`, result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("obs_agrees_with_ps", "observation", "positive", async () => {
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				return { kind: "tool_calls", calls: [{ id: "obs_1", name: "clec", rawArgumentsJson: '{"action":"status"}' }] };
			}
			return { kind: "text", text: "Observation matches." };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "obs_agrees_with_ps",
					evidenceParentDir,
					question: "Observe closure.",
					mockBaseUrl: srv.baseUrl,
				},
				{ cachedClosure: closureBefore },
			);
			const g = res.groupObservations[0];
			assert(g?.closure?.kind === "gone", "recorded closure must be gone");
			const direct = await observeGroupInProcessTable({ pgid: g.pgid!, knownIdentities: [], monotonicStartMs: performance.now() });
			assert(direct.kind === "gone", "direct ps check must agree with recorded closure");
			return { detail: `Direct ps agrees with recorded closure for PGID ${g.pgid}`, result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("obs_ps_failure_unknown", "observation", "negative", async () => {
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				return { kind: "tool_calls", calls: [{ id: "obs_f", name: "clec", rawArgumentsJson: '{"action":"status"}' }] };
			}
			return { kind: "text", text: "Obs failure." };
		});
		try {
			const res = await runUnit1Proof(
				{
					caseLabel: "obs_ps_failure_unknown",
					evidenceParentDir,
					question: "Inject ps failure.",
					mockBaseUrl: srv.baseUrl,
					faults: { injectPsFailure: true },
				},
				{ cachedClosure: closureBefore },
			);
			const g = res.groupObservations[0];
			assert(g?.closure?.kind === "unknown", `expected unknown closure on ps failure, got ${g?.closure?.kind}`);
			assert(g.state === "Unknown", `expected group state Unknown, got ${g.state}`);
			assert(res.uncertified, "Unknown closure must mark uncertified");
			return { detail: `ps failure yielded Unknown/uncertified (reason=${g.closure.reason})`, result: res, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("ownership_exclusive_retained", "ownership_and_bounds", "positive", async () => {
		const srv = await startUnit1LoopbackOpenAI(() => ({ kind: "text", text: "Retention check." }));
		try {
			const r1 = await runUnit1Proof(
				{ caseLabel: "ownership_run_1", evidenceParentDir, question: "First run.", mockBaseUrl: srv.baseUrl },
				{ cachedClosure: closureBefore },
			);
			const h1 = sha256FileStreaming(r1.rawArtifacts.journalPath).sha256;
			const idx1 = sha256FileStreaming(r1.indexEntryPath).sha256;
			assert(r1.rawArtifacts.piStderrPath !== null && existsSync(r1.rawArtifacts.piStderrPath), "zero-byte pi.stderr.bin must exist");

			const r2 = await runUnit1Proof(
				{ caseLabel: "ownership_run_2", evidenceParentDir, question: "Second run.", mockBaseUrl: srv.baseUrl },
				{ cachedClosure: closureBefore },
			);
			assert(r1.runId !== r2.runId && r1.bundleDir !== r2.bundleDir, "runs must allocate distinct exclusive roots");
			assert(sha256FileStreaming(r1.rawArtifacts.journalPath).sha256 === h1, "run 1 journal must remain unchanged");
			assert(sha256FileStreaming(r1.indexEntryPath).sha256 === idx1, "run 1 index entry must remain unchanged");
			return { detail: `Exclusive roots retained (${r1.runId}, ${r2.runId}); prior hashes unchanged`, result: r2, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("ownership_precreated_paths_and_dup_id", "ownership_and_bounds", "negative", async () => {
		const srv = await startUnit1LoopbackOpenAI(() => ({ kind: "text", text: "FORBIDDEN" }));
		try {
			for (const rel of ["APPEND_SYSTEM.md", "SYSTEM.md", "settings.json", "models.json"] as const) {
				const res = await runUnit1Proof(
					{
						caseLabel: `ownership_precreated_${rel}`,
						evidenceParentDir,
						question: "Should reject precreated file.",
						mockBaseUrl: srv.baseUrl,
						faults: { precreateAgentDirFile: { relativePath: rel, content: "PREEXISTING_SENTINEL" } },
					},
					{ cachedClosure: closureBefore },
				);
				assert(res.status === "PreWorkInfrastructureFailed", `expected PreWorkInfrastructureFailed for ${rel}, got ${res.status}`);
				assert(srv.requests.length === 0, `expected 0 provider requests for precreated ${rel}`);
				const preserved = readFileSync(join(evidenceParentDir, "attempts", res.attemptId, "agent", rel), "utf8");
				assert(preserved === "PREEXISTING_SENTINEL", `precreated ${rel} was overwritten`);
			}

			const existingId = makeAttemptId(`dup-attempt-${randomBytes(3).toString("hex")}`);
			const first = await runUnit1Proof(
				{
					caseLabel: "ownership_dup_first",
					evidenceParentDir,
					question: "First with fixed attemptId.",
					mockBaseUrl: srv.baseUrl,
					faults: { duplicateAttemptIdCollision: existingId },
				},
				{ cachedClosure: closureBefore },
			);
			const firstJournalSha = sha256FileStreaming(first.rawArtifacts.journalPath).sha256;
			const second = await runUnit1Proof(
				{
					caseLabel: "ownership_dup_second",
					evidenceParentDir,
					question: "Collision attemptId.",
					mockBaseUrl: srv.baseUrl,
					faults: { duplicateAttemptIdCollision: existingId },
				},
				{ cachedClosure: closureBefore },
			);
			assert(second.status === "PreWorkInfrastructureFailed", `expected collision rejection, got ${second.status}`);
			assert(sha256FileStreaming(first.rawArtifacts.journalPath).sha256 === firstJournalSha, "collision modified first run journal");
			const rejected = JSON.parse(readFileSync(second.indexEntryPath, "utf8"));
			assert(rejected.runId === second.runId, "duplicate attempt index must identify the rejected run");
			assert(rejected.rawArtifacts.journalPath === join(second.bundleDir, "collision.journal.jsonl"), "duplicate attempt must index its own journal");
			assert(rejected.rawArtifacts.piStdoutPath === null && rejected.rawArtifacts.piStderrPath === null, "duplicate attempt never starts Pi");
			const [record] = readFileSync(rejected.rawArtifacts.journalPath, "utf8").split("\n");
			assert(JSON.parse(record).runId === second.runId, "indexed journal must belong to the rejected run");
			return { detail: "All 4 precreated agentDir files + duplicate AttemptId rejected without overwrite", result: second, serverRequests: srv.requests };
		} finally {
			await srv.close();
		}
	});

	add("bounds_caps_and_stalled_sink", "ownership_and_bounds", "negative", async () => {
		const overflowNative = writeFaultBinary(
			fixturesDir,
			"overflow-native.mjs",
			`process.stdout.write("A".repeat(40000));
process.exit(0);`,
		);
		const srv = await startUnit1LoopbackOpenAI((req) => {
			if (req.seq === 1) {
				return { kind: "tool_calls", calls: [{ id: "bnd_1", name: "clec", rawArgumentsJson: '{"action":"status"}' }] };
			}
			return { kind: "text", text: "AFTER_OVERFLOW" };
		});
		try {
			const rNative = await runUnit1Proof(
				{
					caseLabel: "bounds_native_stdout_overflow",
					evidenceParentDir,
					question: "Overflow native stdout.",
					mockBaseUrl: srv.baseUrl,
					faults: { nativeExecOverride: overflowNative, nativeArgsOverride: [] },
				},
				{ cachedClosure: closureBefore },
			);
			const nativeStdoutPath = join(evidenceParentDir, "attempts", rNative.attemptId, "capture", "lease-1.native.stdout.bin");
			const nativeStdoutSize = statSync(nativeStdoutPath).size;
			assert(nativeStdoutSize === UNIT1_LIMITS.nativeStdoutBytes, `expected exact prefix ${UNIT1_LIMITS.nativeStdoutBytes}, got ${nativeStdoutSize}`);
			assert(rNative.uncertified, "overflow must mark uncertified");
			const rNativeJournal = readFileSync(rNative.rawArtifacts.journalPath, "utf8");
			assert(rNativeJournal.includes("overflow_uncertified"), "journal must record overflow_uncertified");

			const stderrFloodExt = writeFaultAdapterFixture(fixturesDir, "stderr_flood");
			const rStderr = await runUnit1Proof(
				{
					caseLabel: "bounds_pi_stderr_flood",
					evidenceParentDir,
					question: "Flood Pi stderr.",
					mockBaseUrl: srv.baseUrl,
					faults: { adapterPathOverride: stderrFloodExt },
				},
				{ cachedClosure: closureBefore },
			);
			assert(rStderr.rawArtifacts.piStderrPath !== null, "Pi stderr capture must exist");
			const piStderrSize = statSync(rStderr.rawArtifacts.piStderrPath).size;
			assert(piStderrSize === UNIT1_LIMITS.piStderrBytes, `expected exact ${UNIT1_LIMITS.piStderrBytes} prefix, got ${piStderrSize}`);
			assert(rStderr.uncertified, "Pi stderr overflow must mark uncertified");

			const jTestPath = join(fixturesDir, "reserve-test.journal.jsonl");
			const jWriter = new BoundedJournalWriter({ path: jTestPath });
			const bigBody = { pad: "Z".repeat(512 * 1024) };
			let normalCount = 0;
			for (let i = 0; i < 150; i++) {
				const res = await jWriter.append(
					{ runId: makeRunId("jcap"), attemptId: makeAttemptId("jcap-a1"), kind: "pi_spawned", body: bigBody },
					i,
				);
				if (!res.ok) break;
				normalCount += 1;
			}
			assert(jWriter.hasFailed, "normal journal writes must stop at 63 MiB normal cap");
			const emergRes = await jWriter.append(
				{ runId: makeRunId("jcap"), attemptId: makeAttemptId("jcap-a1"), kind: "attempt_closed", body: { emergency: true } },
				999,
				"emergency",
			);
			await jWriter.close(performance.now() + UNIT1_LIMITS.killGraceMs);
			assert(emergRes.ok, "1 MiB emergency reserve must accept final attempt_closed after normal cap hit");

			const tStall0 = performance.now();
			const rStall = await runUnit1Proof(
				{
					caseLabel: "bounds_stalled_sink_deadline",
					evidenceParentDir,
					question: "Stalled sink deadline.",
					mockBaseUrl: srv.baseUrl,
					faults: { simulatedSinkStallMs: 1_500, caseDeadlineMsOverride: 900 },
				},
				{ cachedClosure: closureBefore },
			);
			const stallElapsedMs = Math.round(performance.now() - tStall0);
			assert(rStall.status === "DeniedAndTerminated", `expected DeniedAndTerminated under stalled sink deadline, got ${rStall.status}`);
			assert(stallElapsedMs < 3_500, `stalled sink delayed deadline kill: ${stallElapsedMs}ms`);

			return {
				detail: `Native cap=${nativeStdoutSize}, Pi stderr cap=${piStderrSize}, journal normal=${normalCount} + emergency reserve OK, stalled sink terminated cleanly`,
				result: rStall,
				serverRequests: srv.requests,
			};
		} finally {
			await srv.close();
		}
	});

	const outcomes: MatrixCaseOutcome[] = [];
	for (const fn of cases) {
		const out = await fn();
		outcomes.push(out);
		const tag = out.passed ? "PASS" : "FAIL";
		process.stdout.write(`[${tag}] ${out.id} (${out.elapsedMs}ms) -> ${out.detail}\n`);
	}

	const directOwnership = inspectMatrixOwnership(evidenceParentDir);
	const closureAfter = captureExecutionClosure();
	assert(
		closureBefore.closureDigest === closureAfter.closureDigest,
		`Closure changed during matrix run: ${closureBefore.closureDigest} -> ${closureAfter.closureDigest}`,
	);

	const passedCount = outcomes.filter((o) => o.passed).length;
	const failedCount = outcomes.length - passedCount;
	const summary = {
		certificateNotice: UNIT1_LIMITS.certificateNotice,
		toolProfile: UNIT1_LIMITS.toolProfile,
		matrixRunId,
		matrixDir,
		gitHead: gitMeta.head,
		gitDirtyPathsCount: gitMeta.dirtyStatus.length,
		closureBefore,
		closureAfter,
		directOwnership,
		passedCount,
		failedCount,
		totalCount: outcomes.length,
		outcomes,
	};

	const receiptPath = join(matrixDir, "matrix-receipt.json");
	writeExclusiveFile(receiptPath, JSON.stringify(summary, null, 2));
	process.stdout.write(`\nMatrix complete: ${passedCount}/${outcomes.length} passed. Receipt: ${receiptPath}\n`);
	if (directOwnership.survivors.length > 0) {
		process.stderr.write(`Unexpected owned survivors: ${JSON.stringify(directOwnership.survivors)}\n`);
	}
	if (failedCount > 0 || directOwnership.survivors.length > 0) {
		process.exitCode = 1;
	}
}

function inspectMatrixOwnership(evidenceParentDir: string) {
	const index = join(evidenceParentDir, "_index");
	const pids = new Set<number>();
	const pgids = new Set<number>();
	for (const file of readdirSync(index)) {
		const result = JSON.parse(readFileSync(join(index, file), "utf8")) as Partial<ProofRunResult>;
		if (result.piPid) pids.add(result.piPid);
		for (const group of result.groupObservations ?? []) {
			if (group.pgid) pgids.add(group.pgid);
			if (group.helperPid) pids.add(group.helperPid);
			if (group.nativePid) pids.add(group.nativePid);
		}
	}
	const ps = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,stat="], {
		encoding: "utf8", timeout: 2_000, maxBuffer: 1024 * 1024, env: { LC_ALL: "C", LANG: "C" },
	});
	const survivors: string[] = [];
	const rows = ps.trim().split("\n");
	for (const row of rows) {
		const match = /^\s*(\d+)\s+(\d+)\s+\S+\s*$/.exec(row);
		assert(match !== null, "Independent process-table row is malformed");
		if (match && (pids.has(Number(match[1])) || pgids.has(Number(match[2])))) survivors.push(row);
	}
	return { directPsUtc: new Date().toISOString(), pids: [...pids], pgids: [...pgids], survivors };
}

void main();
