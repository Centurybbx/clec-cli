import { closeSync, existsSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { dirname } from "node:path";
import { sha256Buffer } from "./pins.ts";
import type { ProofJournalRecord, Sha256Hex } from "./types.ts";
import { UNIT1_LIMITS } from "./types.ts";

export class FrameCapExceededError extends Error {
	readonly limitBytes: number;
	readonly observedBytes: number;
	constructor(limitBytes: number, observedBytes: number, context: string) {
		super(`${context} exceeded frame cap ${limitBytes} bytes (observed >= ${observedBytes})`);
		this.limitBytes = limitBytes;
		this.observedBytes = observedBytes;
	}
}

/**
 * Bounded JSON serializer: counts UTF-8 bytes as it walks the value, rejects cycles and
 * non-JSON primitives, and stops immediately if maxBytes would be exceeded without building
 * an unbounded second full-size copy.
 */
export function boundedJsonStringify(value: unknown, maxBytes: number): { readonly json: string; readonly byteLength: number } {
	const chunks: string[] = [];
	let byteCount = 0;
	const active = new WeakSet<object>();

	const append = (piece: string): void => {
		const pieceBytes = Buffer.byteLength(piece, "utf8");
		if (byteCount + pieceBytes > maxBytes) {
			throw new FrameCapExceededError(maxBytes, byteCount + pieceBytes, "boundedJsonStringify");
		}
		byteCount += pieceBytes;
		chunks.push(piece);
	};

	const serialize = (val: unknown): void => {
		if (val === null) {
			append("null");
			return;
		}
		const kind = typeof val;
		if (kind === "string") {
			append(JSON.stringify(val));
			return;
		}
		if (kind === "number") {
			append(Number.isFinite(val) ? String(val) : "null");
			return;
		}
		if (kind === "boolean") {
			append(val ? "true" : "false");
			return;
		}
		if (kind === "bigint" || kind === "symbol" || kind === "function" || kind === "undefined") {
			throw new Error(`Unsupported JSON value type: ${kind}`);
		}
		if (typeof val !== "object") {
			throw new Error(`Unexpected value type: ${kind}`);
		}
		const obj = val as object;
		if (active.has(obj)) {
			throw new Error("Circular reference in JSON payload");
		}
		active.add(obj);
		try {
			const maybeToJson = (obj as { toJSON?: unknown }).toJSON;
			if (typeof maybeToJson === "function") {
				serialize((maybeToJson as (this: object) => unknown).call(obj));
				return;
			}
			if (Array.isArray(obj)) {
				append("[");
				for (let i = 0; i < obj.length; i++) {
					if (i > 0) append(",");
					const item = obj[i];
					if (item === undefined || typeof item === "function" || typeof item === "symbol") {
						append("null");
					} else {
						serialize(item);
					}
				}
				append("]");
				return;
			}
			append("{");
			let first = true;
			for (const [k, v] of Object.entries(obj)) {
				if (v === undefined || typeof v === "function" || typeof v === "symbol") {
					continue;
				}
				if (!first) append(",");
				first = false;
				append(JSON.stringify(k));
				append(":");
				serialize(v);
			}
			append("}");
		} finally {
			active.delete(obj);
		}
	};

	serialize(value);
	return { json: chunks.join(""), byteLength: byteCount };
}

export type DeadlineResult<T> = { kind: "completed"; value: T } | { kind: "timeout" };

export function scheduleDeadline(deadline: number, callback: () => void, unref = false): () => void {
	let timer: ReturnType<typeof setTimeout>;
	const check = (): void => {
		if (performance.now() >= deadline) callback();
		else schedule();
	};
	const schedule = (): void => {
		timer = setTimeout(check, Math.max(0, Math.ceil(deadline - performance.now())));
		if (unref) timer.unref();
	};
	schedule();
	return () => clearTimeout(timer);
}

export async function byDeadline<T>(work: Promise<T>, deadline: number): Promise<DeadlineResult<T>> {
	let cancel: (() => void) | undefined;
	try {
		return await Promise.race([
			work.then((value): DeadlineResult<T> =>
				performance.now() <= deadline ? { kind: "completed", value } : { kind: "timeout" },
			),
			new Promise<DeadlineResult<T>>((resolve) => {
				cancel = scheduleDeadline(deadline, () => resolve({ kind: "timeout" }));
			}),
		]);
	} finally {
		cancel?.();
	}
}

export type DrainResult = { kind: "drained" } | { kind: "incomplete"; reason: string };
export type WriteResult = { kind: "written" } | { kind: "overflow" } | { kind: "failed"; reason: string };
const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err);

export function attachBoundedJsonlReader<T>(params: {
	readonly stream: Readable;
	readonly maxFrameBytes: number;
	readonly maxAggregateBytes?: number;
	readonly label: string;
	readonly onRecord: (record: T) => Promise<void>;
	readonly onRawChunk?: (chunk: Buffer) => Promise<void>;
	readonly onError: (err: Error) => void;
	readonly onEnd?: () => void;
}): { done: Promise<DrainResult>; stop: () => void } {
	let stopped = false;
	let ended = false;
	const onEnd = (): void => {
		ended = true;
		if (!stopped) params.onEnd?.();
	};
	const onError = (err: Error): void => {
		if (!stopped) params.onError(err);
	};
	params.stream.once("end", onEnd);
	params.stream.on("error", onError);

	const done = (async (): Promise<DrainResult> => {
		let pieces: Buffer[] = [];
		let frameBytes = 0;
		let aggregate = 0;
			const decoder = new TextDecoder("utf-8", { fatal: true });
		try {
			for await (const chunk of params.stream.iterator({ destroyOnReturn: false })) {
				if (stopped) break;
				await params.onRawChunk?.(chunk);
				if (stopped) break;
				aggregate += chunk.length;
				if (params.maxAggregateBytes !== undefined && aggregate > params.maxAggregateBytes) {
					throw new FrameCapExceededError(params.maxAggregateBytes, aggregate, params.label);
				}
				let offset = 0;
				while (offset < chunk.length && !stopped) {
					const newline = chunk.indexOf(10, offset);
					const end = newline < 0 ? chunk.length : newline;
					const length = end - offset;
					if (frameBytes + length + 1 > params.maxFrameBytes) {
						throw new FrameCapExceededError(params.maxFrameBytes, frameBytes + length + 1, params.label);
					}
					if (newline < 0) {
						pieces.push(Buffer.from(chunk.subarray(offset, end)));
						frameBytes += length;
						break;
					}
					const tail = chunk.subarray(offset, end);
					const line = pieces.length === 0 ? tail : Buffer.concat([...pieces, tail], frameBytes + length);
					pieces = [];
					frameBytes = 0;
					if (line.length > 0) {
						await params.onRecord(JSON.parse(decoder.decode(line)) as T);
					}
					offset = end + 1;
				}
			}
			if (!ended || frameBytes > 0) {
				throw new Error(`${params.label} stopped with incomplete framing`);
			}
			return { kind: "drained" };
		} catch (err) {
			const reason = errorText(err);
			onError(new Error(reason));
			return { kind: "incomplete", reason };
		} finally {
			stopped = true;
			params.stream.off("end", onEnd);
			params.stream.off("error", onError);
		}
	})();
	return {
		done,
		stop: () => {
			stopped = true;
			if (!ended) params.stream.destroy();
		},
	};
}

export async function captureRawStream(
	stream: Readable,
	sink: BoundedRawSink,
	onError: (error: Error) => void,
): Promise<DrainResult> {
	stream.on("error", onError);
	try {
		for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
			const result = await sink.writeChunk(chunk);
			if (result.kind !== "written") return { kind: "incomplete", reason: result.kind };
		}
		return { kind: "drained" };
	} catch (err) {
		return { kind: "incomplete", reason: errorText(err) };
	} finally {
		stream.off("error", onError);
	}
}

async function openExclusive(path: string): Promise<FileHandle> {
	const parent = await lstat(dirname(path));
	if (!parent.isDirectory() || parent.isSymbolicLink()) {
		throw new Error(`Parent path must be a real directory: ${dirname(path)}`);
	}
	return open(path, "wx", 0o600);
}

async function writeExact(file: FileHandle, buffer: Buffer, onProgress?: (bytes: number) => void): Promise<void> {
	let offset = 0;
	while (offset < buffer.length) {
		const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset);
		if (bytesWritten <= 0) throw new Error("File write made no progress");
		offset += bytesWritten;
		onProgress?.(bytesWritten);
	}
}

export class BoundedRawSink {
	private pending: Promise<WriteResult> | undefined;
	private closing: Promise<DrainResult> | undefined;
	private written = 0;
	private failure: string | undefined;
	private overflowed = false;
	private pendingPeak = 0;
	private readonly file: Promise<FileHandle | null>;
	readonly ready: Promise<boolean>;

	private readonly params: {
		readonly path: string;
		readonly maxBytes: number;
		readonly stallMs?: number;
		readonly onOverflow?: (observedBytes: number) => void;
		readonly onWriteFailure?: (err: Error) => void;
	};

	constructor(params: BoundedRawSink["params"]) {
		this.params = params;
		this.file = openExclusive(params.path).catch((err) => {
			this.fail(err);
			return null;
		});
		this.ready = this.file.then((file) => file !== null);
	}

	get bytesWritten(): number { return this.written; }
	get maxPendingObserved(): number { return this.pendingPeak; }

	async writeChunk(chunk: Buffer): Promise<WriteResult> {
		if (this.closing || this.pending || this.failure) {
			return this.fail(new Error(this.failure ?? "Raw sink is closing or already has a pending write"));
		}
		if (this.overflowed) return { kind: "overflow" };
		const remaining = this.params.maxBytes - this.written;
		const length = Math.min(remaining, chunk.length);
		this.overflowed = chunk.length > remaining;
		const work = this.writePrefix(chunk, length);
		this.pending = work;
		if (this.overflowed) this.params.onOverflow?.(this.written + chunk.length);
		try {
			return await work;
		} finally {
			this.pending = undefined;
		}
	}

	private async writePrefix(chunk: Buffer, length: number): Promise<WriteResult> {
		try {
			const file = await this.file;
			if (file === null) return { kind: "failed", reason: this.failure ?? "Open failed" };
			for (let offset = 0; offset < length;) {
				const end = Math.min(length, offset + UNIT1_LIMITS.maxPendingSinkBytes);
				const payload = Buffer.allocUnsafeSlow(end - offset);
				chunk.copy(payload, 0, offset, end);
				this.pendingPeak = Math.max(this.pendingPeak, payload.buffer.byteLength);
				if (this.params.stallMs) await new Promise<void>((resolve) => setTimeout(resolve, this.params.stallMs));
				await writeExact(file, payload, (bytes) => { this.written += bytes; });
				offset = end;
			}
			return { kind: this.overflowed ? "overflow" : "written" };
		} catch (err) {
			return this.fail(err);
		}
	}

	private fail(err: unknown): Extract<WriteResult, { kind: "failed" }> {
		if (!this.failure) {
			this.failure = errorText(err);
			this.params.onWriteFailure?.(new Error(this.failure));
		}
		return { kind: "failed", reason: this.failure };
	}

	async close(deadline: number): Promise<DrainResult> {
		this.closing ??= (async (): Promise<DrainResult> => {
			try {
				await this.pending;
				await (await this.file)?.close();
			} catch (err) {
				this.fail(err);
			}
			return this.failure ? { kind: "incomplete", reason: this.failure } : { kind: "drained" };
		})();
		const result = await byDeadline(this.closing, deadline);
		return result.kind === "completed" ? result.value : { kind: "incomplete", reason: "Raw sink drain deadline" };
	}
}

type JournalRecord = Omit<ProofJournalRecord, "seq" | "monotonicMs" | "utcIso">;
type CommitResult = { readonly ok: true; readonly seq: number; readonly start: number; readonly end: number }
	| { readonly ok: false; readonly error: string };

export class BoundedJournalWriter {
	private readonly file: Promise<FileHandle>;
	private tail: Promise<unknown> = Promise.resolve();
	private closing: Promise<DrainResult> | undefined;
	private queued = 0;
	private seq = 0;
	private bytesWritten = 0;
	private failed = false;
	private corrupted = false;
	private failNextKind: ProofJournalRecord["kind"] | null;

	private readonly params: {
		readonly path: string;
		readonly failNextKind?: ProofJournalRecord["kind"];
		readonly onFailure?: (reason: string) => void;
	};

	constructor(params: BoundedJournalWriter["params"]) {
		this.params = params;
		this.failNextKind = params.failNextKind ?? null;
		this.file = openExclusive(params.path);
		void this.file.catch(() => {});
	}

	get hasFailed(): boolean { return this.failed; }
	get currentSeq(): number { return this.seq; }
	get writtenBytes(): number { return this.bytesWritten; }

	setFailOnKind(kind: ProofJournalRecord["kind"] | null): void {
		this.failNextKind = kind;
	}

	append(record: JournalRecord, monotonicMs: number, mode: "normal" | "durable" | "emergency" = "normal"): Promise<CommitResult> {
		if (this.closing || this.queued >= 4) {
			return Promise.resolve(this.fail("Journal is closing or saturated"));
		}
		const utcIso = new Date().toISOString();
		this.queued++;
		const commit = this.tail.then(async (): Promise<CommitResult> => {
			const emergency = mode === "emergency";
			if (this.corrupted || (this.failed && !emergency)) return { ok: false, error: "Journal writer already failed" };
			if (this.failNextKind === record.kind && !emergency) return this.fail(`Injected journal write failure on ${record.kind}`);
			const seq = this.seq + 1;
			const start = this.bytesWritten;
			const cap = UNIT1_LIMITS.journalTotalBytes - (emergency ? 0 : UNIT1_LIMITS.journalEmergencyReserveBytes);
			let line: Buffer;
			try {
				const { json } = boundedJsonStringify({ seq, monotonicMs, utcIso, ...record }, cap - start - 1);
				line = Buffer.from(`${json}\n`);
			} catch (err) {
				return this.fail(`Journal cap ${cap} or serialization failed: ${errorText(err)}`);
			}
			try {
				const file = await this.file;
				await writeExact(file, line);
				if (mode === "durable") await file.datasync();
				this.bytesWritten += line.length;
				this.seq = seq;
				return { ok: true, seq, start, end: this.bytesWritten };
			} catch (err) {
				this.corrupted = true;
				return this.fail(errorText(err));
			}
		}).finally(() => { this.queued--; });
		this.tail = commit;
		return commit;
	}

	private fail(reason: string): Extract<CommitResult, { ok: false }> {
		if (!this.failed) {
			this.failed = true;
			this.params.onFailure?.(reason);
		}
		return { ok: false, error: reason };
	}

	async close(deadline: number): Promise<DrainResult> {
		this.closing ??= (async (): Promise<DrainResult> => {
			try {
				await this.tail;
				await (await this.file).close();
				return this.corrupted ? { kind: "incomplete", reason: "Journal write failed" } : { kind: "drained" };
			} catch (err) {
				return { kind: "incomplete", reason: errorText(err) };
			}
		})();
		const result = await byDeadline(this.closing, deadline);
		return result.kind === "completed" ? result.value : { kind: "incomplete", reason: "Journal drain deadline" };
	}
}

export async function writeExclusiveFileAsync(path: string, content: string): Promise<void> {
	const file = await openExclusive(path);
	try {
		await writeExact(file, Buffer.from(content));
	} finally {
		await file.close();
	}
}

export function ensureNoSymlinkParent(dirPath: string): void {
	if (!existsSync(dirPath)) {
		throw new Error(`Parent directory does not exist: ${dirPath}`);
	}
	const st = lstatSync(dirPath);
	if (st.isSymbolicLink() || !st.isDirectory()) {
		throw new Error(`Parent path must be a real directory, not symlink: ${dirPath}`);
	}
}

export function createExclusiveDir(dirPath: string): void {
	mkdirSync(dirPath, { recursive: false, mode: 0o700 });
	const st = lstatSync(dirPath);
	if (st.isSymbolicLink() || !st.isDirectory()) {
		throw new Error(`Created path is not an exclusive directory: ${dirPath}`);
	}
}

export function writeExclusiveFile(filePath: string, content: string | Buffer): Sha256Hex {
	const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
	const fd = openSync(filePath, "wx", 0o600);
	try {
		let offset = 0;
		while (offset < buf.length) {
			const n = writeSync(fd, buf, offset, buf.length - offset);
			if (n <= 0) throw new Error(`Short write on ${filePath}`);
			offset += n;
		}
	} finally {
		closeSync(fd);
	}
	return sha256Buffer(buf);
}

export function writeBoundedFrame(stream: Writable, msg: unknown, maxBytes: number): boolean {
	const { json } = boundedJsonStringify(msg, maxBytes - 1);
	return stream.write(`${json}\n`, "utf8");
}
