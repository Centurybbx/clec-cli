import { closeSync, existsSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
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

/**
 * Strict LF-only byte-bounded JSONL stream reader.
 * Enforces maxFrameBytes and maxAggregateBytes BEFORE allocating or JSON-parsing a line.
 */
export function attachBoundedJsonlReader<T>(params: {
	readonly stream: Readable;
	readonly maxFrameBytes: number;
	readonly maxAggregateBytes?: number;
	readonly label: string;
	readonly onRecord: (record: T, rawLineBytes: number) => void;
	readonly onRawChunk?: (chunk: Buffer) => void;
	readonly onError: (err: Error) => void;
	readonly onEnd?: () => void;
}): () => void {
	let lineChunks: Buffer[] = [];
	let lineBytes = 0;
	let aggregateBytes = 0;
	let stopped = false;

	const fail = (err: Error): void => {
		if (stopped) return;
		stopped = true;
		lineChunks = [];
		params.stream.pause();
		params.onError(err);
	};

	const processLine = (buf: Buffer): void => {
		const trimmed = buf.length > 0 && buf[buf.length - 1] === 0x0d ? buf.subarray(0, buf.length - 1) : buf;
		if (trimmed.length === 0) return;
		const text = trimmed.toString("utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			fail(new Error(`${params.label} invalid JSON frame: ${err instanceof Error ? err.message : String(err)}`));
			return;
		}
		params.onRecord(parsed as T, buf.length + 1);
	};

	const onData = (chunk: Buffer): void => {
		if (stopped) return;
		params.onRawChunk?.(chunk);
		let offset = 0;
		while (offset < chunk.length) {
			const nlIndex = chunk.indexOf(0x0a, offset);
			if (nlIndex === -1) {
				const slice = chunk.subarray(offset);
				aggregateBytes += slice.length;
				if (params.maxAggregateBytes !== undefined && aggregateBytes > params.maxAggregateBytes) {
					fail(new FrameCapExceededError(params.maxAggregateBytes, aggregateBytes, `${params.label} aggregate`));
					return;
				}
				if (lineBytes + slice.length > params.maxFrameBytes) {
					fail(new FrameCapExceededError(params.maxFrameBytes, lineBytes + slice.length, `${params.label} frame`));
					return;
				}
				lineChunks.push(Buffer.from(slice));
				lineBytes += slice.length;
				break;
			}
			const slice = chunk.subarray(offset, nlIndex);
			const totalFrameWithNl = lineBytes + slice.length + 1;
			aggregateBytes += slice.length + 1;
			if (params.maxAggregateBytes !== undefined && aggregateBytes > params.maxAggregateBytes) {
				fail(new FrameCapExceededError(params.maxAggregateBytes, aggregateBytes, `${params.label} aggregate`));
				return;
			}
			if (totalFrameWithNl > params.maxFrameBytes) {
				fail(new FrameCapExceededError(params.maxFrameBytes, totalFrameWithNl, `${params.label} frame`));
				return;
			}
			lineChunks.push(Buffer.from(slice));
			const complete = lineChunks.length === 1 ? lineChunks[0] : Buffer.concat(lineChunks, lineBytes + slice.length);
			lineChunks = [];
			lineBytes = 0;
			processLine(complete);
			if (stopped) return;
			offset = nlIndex + 1;
		}
	};

	const onEnd = (): void => {
		if (stopped) return;
		if (lineBytes > 0) {
			const trailing = Buffer.concat(lineChunks, lineBytes);
			lineChunks = [];
			lineBytes = 0;
			processLine(trailing);
		}
		params.onEnd?.();
	};

	const onErr = (err: Error): void => {
		fail(err);
	};

	params.stream.on("data", onData);
	params.stream.on("end", onEnd);
	params.stream.on("error", onErr);

	return () => {
		stopped = true;
		params.stream.off("data", onData);
		params.stream.off("end", onEnd);
		params.stream.off("error", onErr);
	};
}

/**
 * Bounded exclusive raw sink:
 * - Opens file exclusively (wx) so collisions fail without overwriting.
 * - Retains exact prefix up to maxBytes; on overflow marks overflowed and stops writing.
 * - Tracks at most one pending buffer <= 64 KiB (with optional simulated stall for testing),
 *   signalling callers to pause upstream sources rather than building an unbounded write queue.
 */
export class BoundedRawSink {
	readonly path: string;
	readonly maxBytes: number;
	private fd: number | null;
	private writtenBytes = 0;
	private overflowed = false;
	private pendingBytes = 0;
	private closed = false;
	private readonly stallMs: number;
	private readonly onOverflowCallback?: (observedBytes: number) => void;
	private readonly onWriteFailureCallback?: (err: Error) => void;

	constructor(params: {
		readonly path: string;
		readonly maxBytes: number;
		readonly stallMs?: number;
		readonly onOverflow?: (observedBytes: number) => void;
		readonly onWriteFailure?: (err: Error) => void;
	}) {
		this.path = params.path;
		this.maxBytes = params.maxBytes;
		this.stallMs = params.stallMs ?? 0;
		this.onOverflowCallback = params.onOverflow;
		this.onWriteFailureCallback = params.onWriteFailure;
		ensureNoSymlinkParent(dirname(this.path));
		this.fd = openSync(this.path, "wx", 0o600);
	}

	get bytesWritten(): number {
		return this.writtenBytes;
	}

	get hasOverflowed(): boolean {
		return this.overflowed;
	}

	get maxPendingObserved(): number {
		return this.pendingBytes;
	}

	writeChunk(chunk: Buffer, pauseSource?: () => void, resumeSource?: () => void): boolean {
		if (this.closed || this.overflowed || this.fd === null) {
			return false;
		}
		const remaining = this.maxBytes - this.writtenBytes;
		const toWrite = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
		if (toWrite.length > 0) {
			if (this.stallMs > 0 && pauseSource && resumeSource) {
				pauseSource();
				const cappedSlice = toWrite.subarray(0, Math.min(toWrite.length, UNIT1_LIMITS.maxPendingSinkBytes));
				this.pendingBytes = cappedSlice.length;
				setTimeout(() => {
					this.pendingBytes = 0;
					try {
						if (!this.closed && this.fd !== null) {
							this.writeExact(toWrite);
						}
					} catch (err) {
						this.onWriteFailureCallback?.(err instanceof Error ? err : new Error(String(err)));
					} finally {
						resumeSource();
					}
				}, this.stallMs).unref();
			} else {
				try {
					this.writeExact(toWrite);
				} catch (err) {
					this.onWriteFailureCallback?.(err instanceof Error ? err : new Error(String(err)));
					return false;
				}
			}
		}
		if (chunk.length > remaining) {
			this.overflowed = true;
			this.onOverflowCallback?.(this.writtenBytes + chunk.length);
			return false;
		}
		return true;
	}

	private writeExact(buf: Buffer): void {
		if (this.fd === null) return;
		let offset = 0;
		while (offset < buf.length) {
			const n = writeSync(this.fd, buf, offset, buf.length - offset);
			if (n <= 0) {
				throw new Error(`Short write on ${this.path}`);
			}
			offset += n;
			this.writtenBytes += n;
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.fd !== null) {
			try {
				closeSync(this.fd);
			} finally {
				this.fd = null;
			}
		}
	}
}

export class BoundedJournalWriter {
	readonly path: string;
	private fd: number | null;
	private seq = 0;
	private bytesWritten = 0;
	private failed = false;
	private failNextKind: ProofJournalRecord["kind"] | null;
	private readonly normalCapBytes: number;
	private readonly totalCapBytes: number;

	constructor(params: {
		readonly path: string;
		readonly failNextKind?: ProofJournalRecord["kind"];
	}) {
		this.path = params.path;
		this.failNextKind = params.failNextKind ?? null;
		this.totalCapBytes = UNIT1_LIMITS.journalTotalBytes;
		this.normalCapBytes = UNIT1_LIMITS.journalTotalBytes - UNIT1_LIMITS.journalEmergencyReserveBytes;
		ensureNoSymlinkParent(dirname(this.path));
		this.fd = openSync(this.path, "wx", 0o600);
	}

	get hasFailed(): boolean {
		return this.failed;
	}

	get currentSeq(): number {
		return this.seq;
	}

	get writtenBytes(): number {
		return this.bytesWritten;
	}

	setFailOnKind(kind: ProofJournalRecord["kind"] | null): void {
		this.failNextKind = kind;
	}

	append(
		record: Omit<ProofJournalRecord, "seq" | "monotonicMs" | "utcIso">,
		monotonicMs: number,
		emergency = false,
	): { readonly ok: true; readonly seq: number } | { readonly ok: false; readonly error: string } {
		if (this.fd === null || (this.failed && !emergency)) {
			return { ok: false, error: "Journal writer already failed or closed" };
		}
		if (this.failNextKind === record.kind && !emergency) {
			this.failed = true;
			return { ok: false, error: `Injected journal write failure on ${record.kind}` };
		}
		const seq = ++this.seq;
		const full: ProofJournalRecord = {
			seq,
			monotonicMs,
			utcIso: new Date().toISOString(),
			...record,
		};
		const line = `${JSON.stringify(full)}\n`;
		const buf = Buffer.from(line, "utf8");
		const cap = emergency ? this.totalCapBytes : this.normalCapBytes;
		if (this.bytesWritten + buf.length > cap) {
			if (!emergency) {
				this.failed = true;
			}
			return { ok: false, error: `Journal cap ${cap} exceeded` };
		}
		try {
			let offset = 0;
			while (offset < buf.length) {
				const n = writeSync(this.fd, buf, offset, buf.length - offset);
				if (n <= 0) throw new Error("Short write on journal");
				offset += n;
			}
			this.bytesWritten += buf.length;
			return { ok: true, seq };
		} catch (err) {
			this.failed = true;
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	close(): void {
		if (this.fd !== null) {
			try {
				closeSync(this.fd);
			} finally {
				this.fd = null;
			}
		}
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
