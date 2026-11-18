import { execFile, spawn, type ChildProcess } from "node:child_process";
import { lstat } from "node:fs/promises";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { attachBoundedJsonlReader, byDeadline, BoundedJournalWriter, BoundedRawSink, type DrainResult, scheduleDeadline, writeBoundedFrame } from "./framing.ts";
import { buildScrubbedChildEnv } from "./pins.ts";
import type {
	AttemptId,
	GroupLeaseId,
	GroupState,
	HelperChildToOuter,
	HelperOuterToChild,
	ProcessObservation,
	ProofJournalRecord,
	RunId,
} from "./types.ts";
import { UNIT1_LIMITS } from "./types.ts";

export interface PsProcessEntry {
	readonly pid: number;
	readonly ppid: number;
	readonly pgid: number;
	readonly lstart: string;
	readonly command: string;
}

const PS_LINE_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

type ProcessTable = { readonly ok: true; readonly entries: readonly PsProcessEntry[] }
	| { readonly ok: false; readonly reason: string };

const PS_WINDOW_MS = 3_000;
const tableFailure = (reason: string): ProcessTable => ({ ok: false, reason });
let activeObserver: ReturnType<typeof startProcessTable> | undefined;

export async function readOsProcessTable(deadline = performance.now() + PS_WINDOW_MS, freshAfter = 0): Promise<ProcessTable> {
	while (performance.now() < deadline) {
		if (!activeObserver) {
			activeObserver = startProcessTable(deadline);
			void activeObserver.result.finally(() => { activeObserver = undefined; });
		}
		const observer = activeObserver;
		observer.tighten(deadline);
		const result = await byDeadline(observer.result, deadline);
		if (result.kind === "timeout") break;
		if (observer.startedAt >= freshAfter) return result.value;
	}
	return tableFailure("OS process-table observation deadline");
}

function startProcessTable(requestDeadline: number) {
	const startedAt = performance.now();
	let deadline = Math.min(requestDeadline, startedAt + PS_WINDOW_MS);
	let child: ChildProcess | undefined;
	let cancelTimer: (() => void) | undefined;
	let killedForDeadline = false;
	const armTimeout = (): void => {
		cancelTimer?.();
		cancelTimer = scheduleDeadline(deadline, () => {
			killedForDeadline = true;
			child?.kill("SIGKILL");
		});
	};
	const read = new Promise<string>((resolveTable, reject) => {
		// execFile finishes after child close, including overflow kill and reap.
		child = execFile("/bin/ps", ["-ww", "-axo", "pid=,ppid=,pgid=,lstart=,command="], {
			encoding: "utf8", killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
			env: { LC_ALL: "C", LANG: "C" },
		}, (err, stdout, stderr) => {
			cancelTimer?.();
			if (killedForDeadline) reject(new Error("OS process-table observation deadline"));
			else if (err) reject(err);
			else if (stderr.length > 0) reject(new Error("ps emitted diagnostics"));
			else resolveTable(stdout);
		});
		armTimeout();
	});
	const result = collectProcessTable(read, () => deadline);
	return {
		startedAt, result,
		tighten: (earlier: number): void => {
			if (earlier >= deadline || !child || isReaped(child)) return;
			deadline = earlier;
			armTimeout();
		},
	};
}

async function collectProcessTable(output: Promise<string>, deadline: () => number): Promise<ProcessTable> {
	try {
		const raw = await output;
		if (!raw.endsWith("\n")) return tableFailure("Incomplete OS process table");
		const entries: PsProcessEntry[] = [];
		let rows = 0;
		for (const line of raw.split("\n")) {
			if (++rows % 128 === 0) await yieldTurn();
			if (performance.now() >= deadline()) return tableFailure("OS process-table parse deadline");
			if (line.trim().length === 0) continue;
			const match = PS_LINE_RE.exec(line);
			if (!match || !match[5].trim()) return tableFailure("Unparseable OS process-table row");
			const [pid, ppid, pgid] = match.slice(1, 4).map(Number);
			if (![pid, ppid, pgid].every((id) => Number.isSafeInteger(id) && id >= 0)) {
				return tableFailure("Invalid OS process-table identity");
			}
			entries.push({ pid, ppid, pgid, lstart: match[4].replace(/\s+/g, " ").trim(), command: match[5] });
		}
		return entries.length > 0 ? { ok: true, entries } : tableFailure("Empty OS process table");
	} catch (err) {
		return tableFailure(`ps invocation failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

export async function observeGroupInProcessTable(params: {
	readonly pgid: number;
	readonly knownIdentities: ReadonlyArray<{ readonly pid: number; readonly lstart: string | null }>;
	readonly monotonicMs: number;
	readonly deadline?: number;
	readonly freshAfter?: number;
	readonly injectPsFailure?: boolean;
}): Promise<ProcessObservation> {
	const startedAt = performance.now();
	const table = params.injectPsFailure
		? tableFailure("Injected OS process-list observation failure")
		: await readOsProcessTable(params.deadline, params.freshAfter);
	const checkedAtMonotonicMs = params.monotonicMs + performance.now() - startedAt;
	const base = { pgid: params.pgid, checkedAtMonotonicMs };
	if (!table.ok) return { ...base, kind: "unknown", reason: table.reason };
	const known = new Map(params.knownIdentities.map(({ pid, lstart }) => [pid, lstart]));
	const survivors: PsProcessEntry[] = [];
	for (const entry of table.entries) {
		if (known.has(entry.pid)) {
			const start = known.get(entry.pid);
			if (start !== null && start !== entry.lstart) {
				return { ...base, kind: "unknown", reason: `Identity changed for observed PID ${entry.pid}` };
			}
			survivors.push(entry);
		} else if (entry.pgid === params.pgid) {
			survivors.push(entry);
		}
	}
	return survivors.length > 0
		? { ...base, kind: "alive", survivors }
		: { ...base, kind: "gone", pidsChecked: [...known.keys()] };
}

function isReaped(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

export interface StopTrigger {
	readonly at: number;
	readonly detectedAt: number;
}

export interface SignalEvidence {
	readonly triggerAt: number;
	readonly detectedAt: number;
	readonly scheduledKillAt: number;
	readonly signalDeadline: number;
	readonly observationDeadline: number;
	readonly drainDeadline: number;
	termAttemptAt: number | null;
	killAttemptAt: number | null;
	noKillReason: string | null;
	termError: string | null;
	killError: string | null;
	reapedAt: number | null;
	observationCompletedAt: number | null;
	drain: DrainResult | null;
}

export interface ArmedStop {
	readonly evidence: SignalEvidence;
	readonly reaped: Promise<void>;
	readonly retire: (reason: string) => void;
}

export function armStop(params: {
	readonly trigger: StopTrigger;
	readonly child: ChildProcess | null;
	readonly pgid?: number;
	readonly graceMs: number;
	readonly omitSignals?: boolean;
}): ArmedStop {
	const { at, detectedAt } = params.trigger;
	const { child, pgid } = params;
	const deadline = at + UNIT1_LIMITS.killGraceMs;
	const evidence: SignalEvidence = {
		triggerAt: at, detectedAt, scheduledKillAt: at + params.graceMs,
		signalDeadline: deadline, observationDeadline: deadline, drainDeadline: deadline,
		termAttemptAt: null, killAttemptAt: null, noKillReason: null,
		termError: null, killError: null, reapedAt: null, observationCompletedAt: null, drain: null,
	};
	let cancelTimer: (() => void) | undefined;
	const retire = (reason: string): void => {
		cancelTimer?.();
		if (evidence.killAttemptAt === null) evidence.noKillReason ??= reason;
	};
	const reaped = new Promise<void>((resolveReaped) => {
		if (!child?.pid) {
			resolveReaped();
			return;
		}
		const onReaped = (): void => {
			evidence.reapedAt = performance.now();
			if (pgid === undefined) retire("Direct child reaped");
			resolveReaped();
		};
		if (isReaped(child)) onReaped();
		else child.once("exit", onReaped);
	});
	const signal = (kind: "SIGTERM" | "SIGKILL"): string | null => {
		try {
			if (pgid !== undefined) process.kill(-pgid, kind);
			else if (child && !child.kill(kind)) return "ChildProcess.kill returned false";
			return null;
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
	};
	if (params.omitSignals) {
		retire("Teardown omitted by sensitivity control");
	} else if (pgid !== undefined || (child?.pid && !isReaped(child))) {
		cancelTimer = scheduleDeadline(evidence.scheduledKillAt, () => {
			evidence.killAttemptAt = performance.now();
			evidence.killError = signal("SIGKILL");
		});
		evidence.termAttemptAt = performance.now();
		evidence.termError = signal("SIGTERM");
	} else {
		retire("No live child to signal");
	}
	return { evidence, reaped, retire };
}

interface GroupRegistryEntry {
	readonly leaseId: GroupLeaseId;
	state: GroupState;
	helperPid: number | null;
	helperLstart: string | null;
	pgid: number | null;
	nativePid: number | null;
	nativeLstart: string | null;
	registeredBeforeGo: boolean;
	sentinelAbsentAtRegistration: boolean | null;
	closure: ProcessObservation | null;
	child: ChildProcess | null;
	stop: ArmedStop | null;
	cleanup: Promise<void> | null;
	capture: Promise<DrainResult> | null;
	stopCapture: (() => void) | null;
	stdoutSink: BoundedRawSink;
	stderrSink: BoundedRawSink;
	chunksSink: BoundedRawSink;
}

export class ProcessGroupRegistry {
	readonly entries = new Map<GroupLeaseId, GroupRegistryEntry>();
	private stopEpoch: StopTrigger | null = null;
	private readonly monotonicStartMs: number;

	constructor(monotonicStartMs: number) {
		this.monotonicStartMs = monotonicStartMs;
	}

	reserve(params: {
		readonly leaseId: GroupLeaseId;
		readonly captureDir: string;
		readonly stallMs?: number;
		readonly onOverflow: (stream: string, observedBytes: number) => void;
		readonly onSinkFailure: (stream: string, err: Error) => void;
	}): GroupRegistryEntry {
		if (this.stopEpoch || this.entries.has(params.leaseId)) {
			throw new Error(`Cannot reserve group ${params.leaseId}`);
		}
		const sink = (stream: string, suffix: string, maxBytes: number, stallMs?: number): BoundedRawSink =>
			new BoundedRawSink({
				path: join(params.captureDir, `${params.leaseId}.native.${suffix}`), maxBytes, stallMs,
				onOverflow: (bytes) => params.onOverflow(`${params.leaseId}:${stream}`, bytes),
				onWriteFailure: (err) => params.onSinkFailure(`${params.leaseId}:${stream}`, err),
			});
		const entry: GroupRegistryEntry = {
			leaseId: params.leaseId,
			state: "Reserved",
			helperPid: null, helperLstart: null, pgid: null, nativePid: null, nativeLstart: null,
			registeredBeforeGo: false, sentinelAbsentAtRegistration: null, closure: null, child: null,
			stop: null, cleanup: null, capture: null, stopCapture: null,
			stdoutSink: sink("stdout", "stdout.bin", UNIT1_LIMITS.nativeStdoutBytes, params.stallMs),
			stderrSink: sink("stderr", "stderr.bin", UNIT1_LIMITS.nativeStderrBytes, params.stallMs),
			chunksSink: sink("chunks", "chunks.jsonl", UNIT1_LIMITS.controlFrameBytes),
		};
		this.entries.set(params.leaseId, entry);
		return entry;
	}

	beginStop(trigger: StopTrigger, omitSignals = false): void {
		if (this.stopEpoch) return;
		this.stopEpoch = trigger;
		for (const entry of this.entries.values()) this.beginOne(entry, trigger, omitSignals);
	}

	beginOne(entry: GroupRegistryEntry, trigger: StopTrigger, omitSignals = false): ArmedStop {
		if (entry.stop) return entry.stop;
		entry.state = "Stopping";
		entry.stop = armStop({ trigger, child: entry.child, pgid: entry.pgid ?? undefined, graceMs: 400, omitSignals });
		return entry.stop;
	}

	async finishStop(injectPsFailure?: boolean): Promise<void> {
		await Promise.all([...this.entries.values()].map((entry) => this.finishOne(entry, injectPsFailure)));
	}

	finishOne(entry: GroupRegistryEntry, injectPsFailure?: boolean): Promise<void> {
		const stop = entry.stop;
		if (!stop) throw new Error("Cannot reconcile a group before signaling is armed");
		entry.cleanup ??= this.reconcile(entry, stop, injectPsFailure);
		return entry.cleanup;
	}

	private async reconcile(entry: GroupRegistryEntry, stop: ArmedStop, injectPsFailure?: boolean): Promise<void> {
		const { evidence } = stop;
		const capture = async (): Promise<void> => {
			const captured = await byDeadline(entry.capture ?? Promise.resolve<DrainResult>({ kind: "drained" }), evidence.drainDeadline);
			if (captured.kind === "timeout") entry.stopCapture?.();
			const closes = await Promise.all([entry.stdoutSink, entry.stderrSink, entry.chunksSink].map((sink) => sink.close(evidence.drainDeadline)));
			evidence.drain = captured.kind === "timeout"
				? { kind: "incomplete", reason: "Native stream deadline" }
				: closes.find((result) => result.kind === "incomplete")
					?? (captured.value.kind === "drained" ? { kind: "drained" } : captured.value);
		};
		const draining = capture();
		if (entry.pgid !== null) {
			const knownIdentities = [];
			if (entry.helperPid !== null) knownIdentities.push({ pid: entry.helperPid, lstart: entry.helperLstart });
			if (entry.nativePid !== null) knownIdentities.push({ pid: entry.nativePid, lstart: entry.nativeLstart });
			do {
				entry.closure = await observeGroupInProcessTable({
					pgid: entry.pgid, knownIdentities, monotonicMs: performance.now() - this.monotonicStartMs,
					deadline: evidence.observationDeadline, freshAfter: evidence.triggerAt, injectPsFailure,
				});
				if (entry.closure.kind === "gone" && evidence.reapedAt !== null &&
					performance.now() <= evidence.observationDeadline) {
					stop.retire("Owned group absent and direct child reaped");
					break;
				}
				if (evidence.noKillReason === "Teardown omitted by sensitivity control" ||
					(entry.closure.kind === "unknown" && entry.closure.reason.startsWith("Identity changed"))) break;
				await sleepMs(25);
			} while (performance.now() + 25 < evidence.observationDeadline);
		}
		evidence.observationCompletedAt = performance.now();
		const reaped = await byDeadline(stop.reaped, evidence.observationDeadline);
		const closed = reaped.kind === "completed" && (!entry.child?.pid ||
			(entry.closure?.kind === "gone" && evidence.observationCompletedAt <= evidence.observationDeadline));
		entry.state = closed ? "Closed" : "Unknown";
		await draining;
	}

}

export function resolveDefaultHelperPath(): string {
	return resolve(import.meta.dirname, "group-helper.mjs");
}

export interface RunRegisteredNativeParams {
	readonly registry: ProcessGroupRegistry;
	readonly leaseId: GroupLeaseId;
	readonly runId: RunId;
	readonly attemptId: AttemptId;
	readonly captureDir: string;
	readonly dataDir: string;
	readonly cwd: string;
	readonly execPath: string;
	readonly argv: readonly string[];
	readonly helperPath?: string;
	readonly verifyLaunch: () => Promise<void>;
	readonly nativeSentinelPath?: string;
	readonly journal: BoundedJournalWriter;
	readonly monotonicStartMs: number;
	readonly deadlineMs: number;
	readonly abortSignal: AbortSignal;
	readonly skipGoAndCloseHelper?: boolean;
	readonly onKillPiBetweenRegAndGo?: () => Promise<void>;
	readonly onNativeFirstChunk?: () => void;
	readonly onOverflow: (stream: string, observedBytes: number) => void;
	readonly onSinkFailure: (stream: string, err: Error) => void;
	readonly sinkStallMs?: number;
	readonly onFatal: (reason: string, deadline?: number) => void;
}

export interface RunRegisteredNativeOutcome {
	readonly ok: boolean;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly stdoutText: string;
	readonly stderrText: string;
	readonly errorMessage: string | null;
	readonly nativeStarted: boolean;
}

export async function runRegisteredNativeGroup(params: RunRegisteredNativeParams): Promise<RunRegisteredNativeOutcome> {
	const nowMs = (): number => performance.now() - params.monotonicStartMs;
	const deadline = performance.now() + params.deadlineMs;
	const failed = (errorMessage: string): RunRegisteredNativeOutcome =>
		({ ok: false, exitCode: null, signal: null, stdoutText: "", stderrText: "", errorMessage, nativeStarted: false });
	const timeout = (): void => params.onFatal(`Native command exceeded ${params.deadlineMs} ms deadline`, deadline);
	const cancelTimer = scheduleDeadline(deadline, timeout, true);
	const live = (): boolean => {
		if (performance.now() >= deadline) timeout();
		return !params.abortSignal.aborted;
	};
	const commit = async (kind: ProofJournalRecord["kind"], body: Record<string, unknown>, durable = false): Promise<boolean> => {
		const result = await params.journal.append({
			runId: params.runId, attemptId: params.attemptId, kind, body: { leaseId: params.leaseId, ...body },
		}, nowMs(), durable ? "durable" : "normal");
		if (!result.ok) params.onFatal(`${kind} commit failed: ${result.error}`);
		return result.ok && live();
	};
	try {
		const entry = params.registry.reserve({
			leaseId: params.leaseId, captureDir: params.captureDir, stallMs: params.sinkStallMs,
			onOverflow: params.onOverflow, onSinkFailure: params.onSinkFailure,
		});
		await params.verifyLaunch();
		if (!live()) return failed("Native launch stopped during pin verification");
		const ready = await Promise.all([entry.stdoutSink.ready, entry.stderrSink.ready, entry.chunksSink.ready]);
		if (ready.some((opened) => !opened) || !live() || !await commit("group_reserved", {})) {
			return failed("Native reservation did not complete");
		}
		const child = spawn(process.execPath, [params.helperPath ?? resolveDefaultHelperPath(), "--lease", params.leaseId], {
			cwd: params.cwd, env: buildScrubbedChildEnv({ CLEC_DATA_DIR: params.dataDir }),
			detached: true, shell: false, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
		});
		entry.child = child;
		entry.pgid = child.pid ?? null;
		entry.helperPid = entry.pgid;
		entry.state = "WaitingForRegistration";
		const go = child.stdio[3] as Writable;
		const reports = child.stdio[4] as Readable;
		const startupError = (err: Error): void => params.onFatal(err.message);
		child.on("error", startupError);
		go.on("error", startupError);
		if (!entry.pgid) return failed("Helper spawned without a PID");

		let outcome = failed("Helper closed without native exit evidence");
		let nativeStarted = false;
		let completed = false;
		let goSent = false;
		const reportEnded = Promise.withResolvers<number>();
		const aborted = Promise.withResolvers<void>();
		let firstChunk = true;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const fail = (reason: string): void => {
			outcome = { ...failed(reason), nativeStarted };
			params.onFatal(reason);
		};
		const reportChannelEnded = (): void => {
			if (entry.stop) return;
			const at = performance.now();
			if (goSent) {
				const stop = params.registry.beginOne(entry, { at, detectedAt: at });
				reportEnded.resolve(stop.evidence.drainDeadline);
			} else {
				fail("Helper exited or closed its report channel before GO");
			}
		};
		child.once("exit", reportChannelEnded);
		const closeGo = (): void => {
			go.end();
			aborted.resolve();
		};
		params.abortSignal.addEventListener("abort", closeGo, { once: true });
		const reader = attachBoundedJsonlReader<HelperChildToOuter>({
			stream: reports, maxFrameBytes: UNIT1_LIMITS.controlFrameBytes,
			maxAggregateBytes: UNIT1_LIMITS.controlAggregateBytes, label: `helper:${params.leaseId}`,
			onError: (err) => fail(err.message),
			onEnd: reportChannelEnded,
			onRecord: async (rec) => {
				if (rec.leaseId !== params.leaseId) return fail("Helper lease mismatch");
				switch (rec.kind) {
					case "helper_ready": {
						if (!live()) return;
						if (entry.state !== "WaitingForRegistration" || rec.pid !== child.pid || rec.pgid !== child.pid) {
							return fail("Unexpected helper PID/PGID or duplicate readiness");
						}
						const table = await readOsProcessTable(deadline);
						const owned = table.ok ? table.entries.find((row) => row.pid === child.pid) : undefined;
						if (!live()) return;
						if (!owned || owned.pgid !== child.pid || owned.ppid !== process.pid ||
							(rec.lstart !== null && rec.lstart !== owned.lstart) || isReaped(child)) {
							return fail("Could not verify owned helper identity");
						}
						entry.helperLstart = owned.lstart;
						if (params.nativeSentinelPath) {
							entry.sentinelAbsentAtRegistration = await lstat(params.nativeSentinelPath).then(
								() => false,
								(err: NodeJS.ErrnoException) => {
									if (err.code === "ENOENT") return true;
									throw err;
								},
							);
						}
						if (!live()) return;
						if (!await commit("group_registered", {
							helperPid: child.pid, pgid: entry.pgid, helperLstart: owned.lstart,
							sentinelAbsentAtRegistration: entry.sentinelAbsentAtRegistration,
						}, true)) return;
						entry.registeredBeforeGo = entry.sentinelAbsentAtRegistration !== false;
						entry.state = "RegisteredWaiting";
						await params.onKillPiBetweenRegAndGo?.();
						if (!live()) return;
						if (params.skipGoAndCloseHelper) {
							closeGo();
							return fail("Test closed GO pipe before sending GO");
						}
						const goCommand: HelperOuterToChild = {
							kind: "go", leaseId: params.leaseId, execPath: params.execPath, argv: params.argv, cwd: params.cwd,
						};
						if (!await commit("group_go_sent", { execPath: params.execPath, argv: params.argv }, true)) return;
						if (entry.state !== "RegisteredWaiting" || isReaped(child) || go.destroyed || go.writableEnded) {
							return fail("Owned helper unavailable at GO");
						}
						writeBoundedFrame(go, goCommand, UNIT1_LIMITS.controlFrameBytes);
						goSent = true;
						entry.state = "Released";
						break;
					}
					case "native_started": {
						if (!goSent) return fail("Native reported before GO");
						if (nativeStarted || !Number.isSafeInteger(rec.pid) || rec.pid <= 0 || rec.pid === child.pid ||
							rec.pgid !== entry.pgid) return fail("Invalid native PID report");
						nativeStarted = true;
						entry.nativePid = rec.pid;
						const table = await readOsProcessTable(Math.min(deadline, entry.stop?.evidence.observationDeadline ?? deadline));
						const row = table.ok ? table.entries.find((item) => item.pid === rec.pid) : undefined;
						if (!live()) return;
						if (!table.ok || (row && (row.pgid !== entry.pgid || (row.ppid !== child.pid && !isReaped(child)) ||
							(rec.lstart !== null && rec.lstart !== row.lstart)))) return fail("Could not verify native PID report");
						entry.nativeLstart = row?.lstart ?? rec.lstart;
						await commit("native_pid_reported", {
							nativePid: rec.pid, pgid: rec.pgid, observedPgid: row?.pgid ?? null, lstart: entry.nativeLstart,
						});
						break;
					}
					case "native_chunk": {
						if (!nativeStarted || completed || (rec.stream !== "stdout" && rec.stream !== "stderr") ||
							!/^([A-Za-z0-9+/]*={0,2})$/.test(rec.dataBase64) || rec.dataBase64.length % 4 !== 0) {
							return fail("Unexpected native chunk");
						}
						const sink = rec.stream === "stdout" ? entry.stdoutSink : entry.stderrSink;
						const chunks = rec.stream === "stdout" ? stdout : stderr;
						const cap = rec.stream === "stdout" ? UNIT1_LIMITS.nativeStdoutBytes : UNIT1_LIMITS.nativeStderrBytes;
						const byteLength = rec.dataBase64.length / 4 * 3 - (rec.dataBase64.endsWith("==") ? 2 : rec.dataBase64.endsWith("=") ? 1 : 0);
						const prefixLength = Math.min(byteLength, cap - sink.bytesWritten);
						const boundedBase64 = rec.dataBase64.slice(0, Math.ceil(prefixLength / 3) * 4);
						const raw = Buffer.from(boundedBase64, "base64").subarray(0, prefixLength);
						const chunkRecord = Buffer.from(`${JSON.stringify({ stream: rec.stream, bytes: byteLength, monotonicMs: nowMs() })}\n`);
						if (byteLength > prefixLength) params.onOverflow(`${params.leaseId}:${rec.stream}`, sink.bytesWritten + byteLength);
						if (firstChunk) {
							firstChunk = false;
							params.onNativeFirstChunk?.();
						}
						chunks.push(raw);
						await Promise.all([entry.chunksSink.writeChunk(chunkRecord), sink.writeChunk(raw)]);
						if (byteLength > prefixLength) reader.stop();
						break;
					}
					case "native_exited": {
						if (!nativeStarted || completed) return fail("Unexpected native exit report");
						completed = true;
						await commit("native_exited", { exitCode: rec.exitCode, signal: rec.signal });
						outcome = {
							ok: rec.exitCode === 0, exitCode: rec.exitCode, signal: rec.signal,
							stdoutText: Buffer.concat(stdout).toString("utf8"), stderrText: Buffer.concat(stderr).toString("utf8"),
							errorMessage: rec.exitCode === 0 ? null : `Native exited code=${rec.exitCode} signal=${rec.signal}`,
							nativeStarted,
						};
						break;
					}
					case "helper_error":
						fail(rec.message);
						break;
					default:
						fail("Unexpected helper record");
				}
			},
		});
		entry.stopCapture = reader.stop;
		entry.capture = reader.done;
		const captured = await byDeadline(Promise.race([
			reader.done,
			aborted.promise,
			reportEnded.promise.then(async (drainDeadline) => {
				const drained = await byDeadline(reader.done, drainDeadline);
				if (drained.kind === "timeout") fail("Native report drain deadline");
			}),
		]), deadline);
		params.abortSignal.removeEventListener("abort", closeGo);
		if (!params.abortSignal.aborted) {
			if (captured.kind === "timeout") timeout();
			else if (!completed) fail(outcome.errorMessage ?? "Missing native exit");
		}
		return { ...outcome, nativeStarted };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		params.onFatal(reason);
		return failed(reason);
	} finally {
		cancelTimer();
	}
}

function sleepMs(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
