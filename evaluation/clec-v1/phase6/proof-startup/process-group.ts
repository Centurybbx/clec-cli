import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { attachBoundedJsonlReader, BoundedJournalWriter, BoundedRawSink, writeBoundedFrame } from "./framing.ts";
import { buildScrubbedChildEnv } from "./pins.ts";
import type {
	AttemptId,
	GroupLeaseId,
	GroupState,
	HelperChildToOuter,
	HelperOuterToChild,
	ProcessObservation,
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

export function readOsProcessTable(): { readonly ok: true; readonly entries: readonly PsProcessEntry[] } | { readonly ok: false; readonly reason: string } {
	try {
		const raw = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,command="], {
			encoding: "utf8",
			timeout: 3_000,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, LC_ALL: "C", LANG: "C" },
		});
		const entries: PsProcessEntry[] = [];
		for (const line of raw.split("\n")) {
			if (line.trim().length === 0) continue;
			const m = PS_LINE_RE.exec(line);
			if (!m) return { ok: false, reason: "Unparseable OS process-table row" };
			const pid = Number(m[1]);
			const ppid = Number(m[2]);
			const pgid = Number(m[3]);
			if (![pid, ppid, pgid].every((id) => Number.isSafeInteger(id) && id >= 0)) {
				return { ok: false, reason: "Invalid OS process-table identity" };
			}
			entries.push({
				pid,
				ppid,
				pgid,
				lstart: m[4].replace(/\s+/g, " ").trim(),
				command: m[5],
			});
		}
		return entries.length > 0 ? { ok: true, entries } : { ok: false, reason: "Empty OS process table" };
	} catch (err) {
		return {
			ok: false,
			reason: `ps invocation failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

export function observeGroupInProcessTable(params: {
	readonly pgid: number;
	readonly knownIdentities: ReadonlyArray<{ readonly pid: number; readonly lstart: string | null }>;
	readonly monotonicMs: number;
	readonly injectPsFailure?: boolean;
}): ProcessObservation {
	if (params.injectPsFailure) {
		return {
			kind: "unknown",
			pgid: params.pgid,
			checkedAtMonotonicMs: params.monotonicMs,
			reason: "Injected OS process-list observation failure",
		};
	}
	const table = readOsProcessTable();
	if (!table.ok) {
		return {
			kind: "unknown",
			pgid: params.pgid,
			checkedAtMonotonicMs: params.monotonicMs,
			reason: table.reason,
		};
	}
	const knownMap = new Map<number, string | null>();
	for (const id of params.knownIdentities) {
		knownMap.set(id.pid, id.lstart);
	}
	const survivors = table.entries.filter((entry) => {
		if (entry.pgid === params.pgid) return true;
		if (knownMap.has(entry.pid)) {
			const recordedLstart = knownMap.get(entry.pid);
			return recordedLstart === null || entry.lstart === recordedLstart;
		}
		return false;
	});
	if (survivors.length === 0) {
		return {
			kind: "gone",
			pgid: params.pgid,
			checkedAtMonotonicMs: params.monotonicMs,
			pidsChecked: params.knownIdentities.map((k) => k.pid),
		};
	}
	return {
		kind: "alive",
		pgid: params.pgid,
		checkedAtMonotonicMs: params.monotonicMs,
		survivors,
	};
}

export interface GroupRegistryEntry {
	readonly leaseId: GroupLeaseId;
	state: GroupState;
	helperPid: number | null;
	helperLstart: string | null;
	pgid: number | null;
	nativePid: number | null;
	nativeLstart: string | null;
	registeredBeforeGo: boolean;
	sentinelAbsentAtRegistration: boolean | null;
	killEscalationMs: number | null;
	closure: ProcessObservation | null;
	child: ChildProcess | null;
	stdoutSink: BoundedRawSink;
	stderrSink: BoundedRawSink;
	chunksSink: BoundedRawSink;
}

export class ProcessGroupRegistry {
	readonly entries = new Map<GroupLeaseId, GroupRegistryEntry>();
	private readonly monotonicStartMs: number;

	constructor(monotonicStartMs: number) {
		this.monotonicStartMs = monotonicStartMs;
	}

	private nowMs(): number {
		return Math.round(performance.now() - this.monotonicStartMs);
	}

	reserve(params: {
		readonly leaseId: GroupLeaseId;
		readonly captureDir: string;
		readonly stallMs?: number;
		readonly onOverflow: (stream: string, observedBytes: number) => void;
		readonly onSinkFailure: (stream: string, err: Error) => void;
	}): GroupRegistryEntry {
		if (this.entries.has(params.leaseId)) {
			throw new Error(`Duplicate GroupLeaseId in registry: ${params.leaseId}`);
		}
		const stdoutSink = new BoundedRawSink({
			path: join(params.captureDir, `${params.leaseId}.native.stdout.bin`),
			maxBytes: UNIT1_LIMITS.nativeStdoutBytes,
			stallMs: params.stallMs,
			onOverflow: (n) => params.onOverflow(`${params.leaseId}:stdout`, n),
			onWriteFailure: (err) => params.onSinkFailure(`${params.leaseId}:stdout`, err),
		});
		const stderrSink = new BoundedRawSink({
			path: join(params.captureDir, `${params.leaseId}.native.stderr.bin`),
			maxBytes: UNIT1_LIMITS.nativeStderrBytes,
			stallMs: params.stallMs,
			onOverflow: (n) => params.onOverflow(`${params.leaseId}:stderr`, n),
			onWriteFailure: (err) => params.onSinkFailure(`${params.leaseId}:stderr`, err),
		});
		const chunksSink = new BoundedRawSink({
			path: join(params.captureDir, `${params.leaseId}.native.chunks.jsonl`),
			maxBytes: UNIT1_LIMITS.controlFrameBytes,
			onOverflow: (n) => params.onOverflow(`${params.leaseId}:chunks`, n),
			onWriteFailure: (err) => params.onSinkFailure(`${params.leaseId}:chunks`, err),
		});
		const entry: GroupRegistryEntry = {
			leaseId: params.leaseId,
			state: "Reserved",
			helperPid: null,
			helperLstart: null,
			pgid: null,
			nativePid: null,
			nativeLstart: null,
			registeredBeforeGo: false,
			sentinelAbsentAtRegistration: null,
			killEscalationMs: null,
			closure: null,
			child: null,
			stdoutSink,
			stderrSink,
			chunksSink,
		};
		this.entries.set(params.leaseId, entry);
		return entry;
	}

	async stopAll(params: {
		readonly journal: BoundedJournalWriter;
		readonly runId: RunId;
		readonly attemptId: AttemptId;
		readonly injectPsFailure?: boolean;
		readonly omitTeardownForTesting?: boolean;
	}): Promise<void> {
		if (params.omitTeardownForTesting) {
			for (const entry of this.entries.values()) {
				if (entry.pgid !== null) {
					const known = buildKnownIdentities(entry);
					entry.closure = observeGroupInProcessTable({
						pgid: entry.pgid,
						knownIdentities: known,
						monotonicMs: this.nowMs(),
						injectPsFailure: params.injectPsFailure,
					});
					if (entry.closure.kind === "alive") {
						entry.state = "Unknown";
					}
					params.journal.append(
						{
							runId: params.runId,
							attemptId: params.attemptId,
							kind: "group_closure_observed",
							body: {
								leaseId: entry.leaseId,
								omittedTeardown: true,
								observation: entry.closure,
							},
						},
						this.nowMs(),
						true,
					);
				}
			}
			return;
		}

		for (const entry of this.entries.values()) {
			await this.stopOne(entry, params.journal, params.runId, params.attemptId, params.injectPsFailure);
		}
	}

	async stopOne(
		entry: GroupRegistryEntry,
		journal: BoundedJournalWriter,
		runId: RunId,
		attemptId: AttemptId,
		injectPsFailure?: boolean,
	): Promise<void> {
		try {
			const startMs = performance.now();
			const known = buildKnownIdentities(entry);
			if (entry.pgid !== null) {
				signalGroupAndKnown(entry.pgid, known, "SIGTERM");
				const termDeadline = startMs + 400;
				while (performance.now() < termDeadline) {
					const obs = observeGroupInProcessTable({
						pgid: entry.pgid,
						knownIdentities: known,
						monotonicMs: this.nowMs(),
					});
					if (obs.kind === "gone") {
						entry.killEscalationMs = Math.round(performance.now() - startMs);
						entry.closure = injectPsFailure
							? observeGroupInProcessTable({
									pgid: entry.pgid,
									knownIdentities: known,
									monotonicMs: this.nowMs(),
									injectPsFailure: true,
								})
							: obs;
						entry.state = entry.closure.kind === "gone" ? "Closed" : "Unknown";
						journal.append(
							{
								runId,
								attemptId,
								kind: "group_closure_observed",
								body: {
									leaseId: entry.leaseId,
									killEscalationMs: entry.killEscalationMs,
									observation: entry.closure,
								},
							},
							this.nowMs(),
							true,
						);
						return;
					}
					await sleepMs(30);
				}
				signalGroupAndKnown(entry.pgid, known, "SIGKILL");
				const killDeadline = startMs + UNIT1_LIMITS.killGraceMs;
				while (performance.now() < killDeadline) {
					const obs = observeGroupInProcessTable({
						pgid: entry.pgid,
						knownIdentities: known,
						monotonicMs: this.nowMs(),
					});
					if (obs.kind === "gone") {
						entry.killEscalationMs = Math.round(performance.now() - startMs);
						entry.closure = injectPsFailure
							? observeGroupInProcessTable({
									pgid: entry.pgid,
									knownIdentities: known,
									monotonicMs: this.nowMs(),
									injectPsFailure: true,
								})
							: obs;
						entry.state = entry.closure.kind === "gone" ? "Closed" : "Unknown";
						journal.append(
							{
								runId,
								attemptId,
								kind: "group_closure_observed",
								body: {
									leaseId: entry.leaseId,
									killEscalationMs: entry.killEscalationMs,
									observation: entry.closure,
								},
							},
							this.nowMs(),
							true,
						);
						return;
					}
					await sleepMs(30);
				}
				entry.killEscalationMs = Math.round(performance.now() - startMs);
				entry.closure = observeGroupInProcessTable({
					pgid: entry.pgid,
					knownIdentities: known,
					monotonicMs: this.nowMs(),
					injectPsFailure,
				});
				entry.state = entry.closure.kind === "gone" ? "Closed" : "Unknown";
				journal.append(
					{
						runId,
						attemptId,
						kind: "group_closure_observed",
						body: {
							leaseId: entry.leaseId,
							killEscalationMs: entry.killEscalationMs,
							observation: entry.closure,
						},
					},
					this.nowMs(),
					true,
				);
			} else if (entry.child && entry.child.exitCode === null) {
				try {
					entry.child.kill("SIGKILL");
				} catch {
					// Ignore if already exited
				}
				entry.state = "Unknown";
			}
		} finally {
			entry.stdoutSink.close();
			entry.stderrSink.close();
			entry.chunksSink.close();
		}
	}
}

function buildKnownIdentities(entry: GroupRegistryEntry): ReadonlyArray<{ readonly pid: number; readonly lstart: string | null }> {
	const list: Array<{ readonly pid: number; readonly lstart: string | null }> = [];
	if (entry.helperPid !== null) {
		list.push({ pid: entry.helperPid, lstart: entry.helperLstart });
	}
	if (entry.nativePid !== null) {
		list.push({ pid: entry.nativePid, lstart: entry.nativeLstart });
	}
	return list;
}

function signalGroupAndKnown(
	pgid: number,
	known: ReadonlyArray<{ readonly pid: number; readonly lstart: string | null }>,
	sig: "SIGTERM" | "SIGKILL",
): void {
	try {
		process.kill(-pgid, sig);
	} catch {
		// Group may already be empty
	}
	if (known.length === 0) return;
	const table = readOsProcessTable();
	if (!table.ok) return;
	for (const k of known) {
		const found = table.entries.find((e) => e.pid === k.pid);
		if (!found) continue;
		if (k.lstart === null || found.lstart === k.lstart) {
			try {
				process.kill(k.pid, sig);
			} catch {
				// Ignore
			}
		}
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
	readonly injectPsFailure?: boolean;
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
	const nowMs = (): number => Math.round(performance.now() - params.monotonicStartMs);
	const entry = params.registry.reserve({
		leaseId: params.leaseId,
		captureDir: params.captureDir,
		stallMs: params.sinkStallMs,
		onOverflow: params.onOverflow,
		onSinkFailure: params.onSinkFailure,
	});
	const reserveRes = params.journal.append(
		{
			runId: params.runId,
			attemptId: params.attemptId,
			kind: "group_reserved",
			body: { leaseId: params.leaseId },
		},
		nowMs(),
	);
	if (!reserveRes.ok) {
		return {
			ok: false,
			exitCode: null,
			signal: null,
			stdoutText: "",
			stderrText: "",
			errorMessage: reserveRes.error,
			nativeStarted: false,
		};
	}

	const helperPath = params.helperPath ?? resolveDefaultHelperPath();
	const childEnv = buildScrubbedChildEnv({
		CLEC_DATA_DIR: params.dataDir,
	});

	let child: ChildProcess;
	try {
		child = spawn(process.execPath, [helperPath, "--lease", params.leaseId], {
			cwd: params.cwd,
			env: childEnv,
			detached: true,
			shell: false,
			stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
		});
	} catch (err) {
		return {
			ok: false,
			exitCode: null,
			signal: null,
			stdoutText: "",
			stderrText: "",
			errorMessage: `Failed to spawn group helper: ${err instanceof Error ? err.message : String(err)}`,
			nativeStarted: false,
		};
	}

	entry.child = child;
	const goWriteStream = child.stdio[3] as Writable | null;
	const helperReadStream = child.stdio[4] as NodeJS.ReadableStream | null;

	if (!goWriteStream || !helperReadStream || typeof child.pid !== "number") {
		await params.registry.stopOne(entry, params.journal, params.runId, params.attemptId, params.injectPsFailure);
		return {
			ok: false,
			exitCode: null,
			signal: null,
			stdoutText: "",
			stderrText: "",
			errorMessage: "Helper spawned without expected PID or private GO pipes",
			nativeStarted: false,
		};
	}

	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	let stdoutBytesTotal = 0;
	let stderrBytesTotal = 0;
	let nativeStarted = false;
	let firstChunkSeen = false;
	let detachReader: (() => void) | null = null;

	const finishOutcome = await new Promise<RunRegisteredNativeOutcome>((resolveOutcome) => {
		let settled = false;
		let registrationDone = false;
		let exitCode: number | null = null;
		let exitSignal: string | null = null;
		let errorMessage: string | null = null;

		const settle = (ok: boolean, msg: string | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			params.abortSignal.removeEventListener("abort", onAbort);
			detachReader?.();
			try {
				goWriteStream.end();
			} catch {
				// Ignore
			}
			const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
			const stderrText = Buffer.concat(stderrChunks).toString("utf8");
			resolveOutcome({
				ok,
				exitCode,
				signal: exitSignal,
				stdoutText,
				stderrText,
				errorMessage: msg ?? errorMessage,
				nativeStarted,
			});
		};

		const onAbort = (): void => {
			settle(false, "Aborted by outer supervisor (Pi death or run termination)");
		};
		params.abortSignal.addEventListener("abort", onAbort, { once: true });

		const timer = setTimeout(() => {
			settle(false, `Native command exceeded ${params.deadlineMs} ms deadline`);
		}, params.deadlineMs);
		timer.unref();

		if (params.abortSignal.aborted) {
			onAbort();
			return;
		}

		detachReader = attachBoundedJsonlReader<HelperChildToOuter>({
			stream: helperReadStream as unknown as import("node:stream").Readable,
			maxFrameBytes: UNIT1_LIMITS.controlFrameBytes,
			maxAggregateBytes: UNIT1_LIMITS.controlAggregateBytes,
			label: `helper:${params.leaseId}`,
			onError: (err) => {
				settle(false, err.message);
			},
			onEnd: () => {
				if (!settled) {
					settle(
						registrationDone && exitCode === 0 && errorMessage === null,
						errorMessage ?? (registrationDone ? null : "Helper closed channel before completion"),
					);
				}
			},
			onRecord: (rec) => {
				if (settled) return;
				if (rec.leaseId !== params.leaseId) {
					settle(false, `Helper lease mismatch: expected ${params.leaseId}, got ${rec.leaseId}`);
					return;
				}
				switch (rec.kind) {
					case "helper_ready": {
						if (registrationDone) {
							settle(false, "Duplicate helper_ready");
							return;
						}
						const table = readOsProcessTable();
						const osEntry = table.ok ? table.entries.find((e) => e.pid === rec.pid) : undefined;
						if (!table.ok || !osEntry || osEntry.pgid !== rec.pgid) {
							settle(false, `Failed to verify helper PID=${rec.pid} PGID=${rec.pgid} in OS process table`);
							return;
						}
						entry.helperPid = rec.pid;
						entry.pgid = rec.pgid;
						entry.helperLstart = osEntry.lstart;
						entry.sentinelAbsentAtRegistration =
							params.nativeSentinelPath !== undefined ? !existsSync(params.nativeSentinelPath) : null;
						entry.registeredBeforeGo = entry.sentinelAbsentAtRegistration !== false;

						const regCommit = params.journal.append(
							{
								runId: params.runId,
								attemptId: params.attemptId,
								kind: "group_registered",
								body: {
									leaseId: params.leaseId,
									helperPid: entry.helperPid,
									pgid: entry.pgid,
									helperLstart: entry.helperLstart,
									sentinelAbsentAtRegistration: entry.sentinelAbsentAtRegistration,
								},
							},
							nowMs(),
						);
						if (!regCommit.ok) {
							settle(false, `GroupRegistered commit failed: ${regCommit.error}`);
							return;
						}
						entry.state = "RegisteredWaiting";
						registrationDone = true;

						const proceedToGo = async (): Promise<void> => {
							if (params.onKillPiBetweenRegAndGo) {
								await params.onKillPiBetweenRegAndGo();
							}
							if (params.abortSignal.aborted || settled) {
								settle(false, "Aborted between GroupRegistered and GO");
								return;
							}
							if (params.skipGoAndCloseHelper) {
								goWriteStream.end();
								settle(false, "Test closed GO pipe before sending GO");
								return;
							}
							const goCmd: HelperOuterToChild = {
								kind: "go",
								leaseId: params.leaseId,
								execPath: params.execPath,
								argv: params.argv,
								cwd: params.cwd,
							};
							const goCommit = params.journal.append(
								{
									runId: params.runId,
									attemptId: params.attemptId,
									kind: "group_go_sent",
									body: { leaseId: params.leaseId, execPath: params.execPath, argv: params.argv },
								},
								nowMs(),
							);
							if (!goCommit.ok) {
								settle(false, `GroupGo commit failed: ${goCommit.error}`);
								return;
							}
							entry.state = "Released";
							writeBoundedFrame(goWriteStream, goCmd, UNIT1_LIMITS.controlFrameBytes);
						};
						void proceedToGo().catch((err) => {
							settle(false, err instanceof Error ? err.message : String(err));
						});
						break;
					}
					case "native_started": {
						nativeStarted = true;
						const table = readOsProcessTable();
						const osEntry = table.ok ? table.entries.find((e) => e.pid === rec.pid) : undefined;
						entry.nativePid = rec.pid;
						entry.nativeLstart = osEntry ? osEntry.lstart : rec.lstart;
						params.journal.append(
							{
								runId: params.runId,
								attemptId: params.attemptId,
								kind: "native_pid_reported",
								body: {
									leaseId: params.leaseId,
									nativePid: rec.pid,
									pgid: rec.pgid,
									observedPgid: osEntry?.pgid ?? null,
									lstart: entry.nativeLstart,
								},
							},
							nowMs(),
						);
						break;
					}
					case "native_chunk": {
						const rawChunk = Buffer.from(rec.dataBase64, "base64");
						const chunkRecord = Buffer.from(
							`${JSON.stringify({ stream: rec.stream, bytes: rawChunk.length, monotonicMs: nowMs() })}\n`,
							"utf8",
						);
						entry.chunksSink.writeChunk(chunkRecord);
						if (rec.stream === "stdout") {
							const ok = entry.stdoutSink.writeChunk(
								rawChunk,
								() => (helperReadStream as unknown as import("node:stream").Readable).pause(),
								() => (helperReadStream as unknown as import("node:stream").Readable).resume(),
							);
							if (stdoutBytesTotal < UNIT1_LIMITS.nativeStdoutBytes) {
								const keep = rawChunk.subarray(0, UNIT1_LIMITS.nativeStdoutBytes - stdoutBytesTotal);
								stdoutChunks.push(keep);
								stdoutBytesTotal += keep.length;
							}
							if (!ok && entry.stdoutSink.hasOverflowed) {
								settle(false, `Native stdout exceeded ${UNIT1_LIMITS.nativeStdoutBytes} byte cap`);
								return;
							}
						} else {
							const ok = entry.stderrSink.writeChunk(
								rawChunk,
								() => (helperReadStream as unknown as import("node:stream").Readable).pause(),
								() => (helperReadStream as unknown as import("node:stream").Readable).resume(),
							);
							if (stderrBytesTotal < UNIT1_LIMITS.nativeStderrBytes) {
								const keep = rawChunk.subarray(0, UNIT1_LIMITS.nativeStderrBytes - stderrBytesTotal);
								stderrChunks.push(keep);
								stderrBytesTotal += keep.length;
							}
							if (!ok && entry.stderrSink.hasOverflowed) {
								settle(false, `Native stderr exceeded ${UNIT1_LIMITS.nativeStderrBytes} byte cap`);
								return;
							}
						}
						if (!firstChunkSeen) {
							firstChunkSeen = true;
							params.onNativeFirstChunk?.();
						}
						break;
					}
					case "native_exited": {
						exitCode = rec.exitCode;
						exitSignal = rec.signal;
						params.journal.append(
							{
								runId: params.runId,
								attemptId: params.attemptId,
								kind: "native_exited",
								body: {
									leaseId: params.leaseId,
									exitCode,
									signal: exitSignal,
								},
							},
							nowMs(),
						);
						settle(exitCode === 0, exitCode === 0 ? null : `Native exited code=${String(exitCode)} signal=${String(exitSignal)}`);
						break;
					}
					case "helper_error": {
						errorMessage = rec.message;
						settle(false, rec.message);
						break;
					}
				}
			},
		});

		child.on("exit", (code, sig) => {
			// Leader exit alone must NOT close the group if a child survives in PGID.
			if (!settled && !registrationDone) {
				settle(false, `Helper exited before registration (code=${String(code)}, sig=${String(sig)})`);
			}
		});
	});

	return finishOutcome;
}

function sleepMs(ms: number): Promise<void> {
	return new Promise((resolveSleep) => {
		setTimeout(resolveSleep, ms);
	});
}
