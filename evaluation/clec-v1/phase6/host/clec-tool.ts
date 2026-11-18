import type { PipeOuterToChild as OuterMsg } from "./clec-tool/protocol.ts";
import { CLEC_TOOL_DESCRIPTION, CLEC_TOOL_PARAMETERS_SCHEMA } from "./contract/request.ts";
import { createHash } from "node:crypto";
import { Socket } from "node:net";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_CONTROL_FRAME_BYTES = 16 * 1024 * 1024;

function boundedJsonStringify(value: unknown, maxBytes: number): { readonly json: string; readonly byteLength: number } {
	const chunks: string[] = [];
	let byteCount = 0;
	const active = new WeakSet<object>();

	const append = (piece: string): void => {
		const len = Buffer.byteLength(piece, "utf8");
		if (byteCount + len > maxBytes) {
			throw new Error(`Payload exceeds ${maxBytes} bytes`);
		}
		byteCount += len;
		chunks.push(piece);
	};

	const walk = (val: unknown): void => {
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
			throw new Error(`Unsupported JSON type: ${kind}`);
		}
		if (typeof val !== "object") {
			throw new Error(`Unexpected type: ${kind}`);
		}
		const obj = val as object;
		if (active.has(obj)) {
			throw new Error("Circular reference in payload");
		}
		active.add(obj);
		try {
			const maybeToJson = (obj as { toJSON?: unknown }).toJSON;
			if (typeof maybeToJson === "function") {
				walk((maybeToJson as (this: object) => unknown).call(obj));
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
						walk(item);
					}
				}
				append("]");
				return;
			}
			append("{");
			let first = true;
			for (const [k, v] of Object.entries(obj)) {
				if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
				if (!first) append(",");
				first = false;
				append(JSON.stringify(k));
				append(":");
				walk(v);
			}
			append("}");
		} finally {
			active.delete(obj);
		}
	};

	walk(value);
	return { json: chunks.join(""), byteLength: byteCount };
}

export default function clecUnit1Adapter(pi: ExtensionAPI): void {
	const ctrlIn = new Socket({ fd: 3 });
	const ctrlOut = new Socket({ fd: 4 });

	let outboundSeq = 0;
	let boundAttemptId: string | null = null;
	let lastOuterSeq = 0;
	let channelBroken = false;

	const pendingReadyAck = new Map<number, (msg: Extract<OuterMsg, { kind: "bound_ready_ack" }>) => void>();
	const pendingPermits = new Map<number, (msg: Extract<OuterMsg, { kind: "provider_permit" }>) => void>();
	const pendingToolStartAcks = new Map<number, (msg: Extract<OuterMsg, { kind: "tool_start_ack" }>) => void>();
	const pendingToolResults = new Map<number, (msg: Extract<OuterMsg, { kind: "tool_result" }>) => void>();

	const sendToOuter = (msg: unknown): boolean => {
		if (channelBroken || ctrlOut.destroyed || ctrlOut.writableEnded) return false;
		try {
			const { json } = boundedJsonStringify(msg, MAX_CONTROL_FRAME_BYTES - 1);
			// A false write return means the frame is queued. The peer can
			// still acknowledge it after the socket drains.
			ctrlOut.write(`${json}\n`, "utf8");
			return true;
		} catch {
			return false;
		}
	};

	const markChannelBroken = (): void => {
		channelBroken = true;
	};

	let lineChunks: Buffer[] = [];
	let lineBytes = 0;

	const handleLine = (buf: Buffer): void => {
		const trimmed = buf.length > 0 && buf[buf.length - 1] === 0x0d ? buf.subarray(0, buf.length - 1) : buf;
		if (trimmed.length === 0) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed.toString("utf8"));
		} catch {
			return;
		}
		if (!parsed || typeof parsed !== "object" || !("kind" in parsed)) return;
		const msg = parsed as OuterMsg;
		if (typeof (msg as { seq?: unknown }).seq !== "number") return;

		switch (msg.kind) {
			case "bound_ready_ack": {
				const cb = pendingReadyAck.get(msg.seq);
				if (cb) {
					pendingReadyAck.delete(msg.seq);
					cb(msg);
				}
				break;
			}
			case "provider_permit": {
				const cb = pendingPermits.get(msg.seq);
				if (cb) {
					pendingPermits.delete(msg.seq);
					cb(msg);
				}
				break;
			}
			case "tool_start_ack": {
				const cb = pendingToolStartAcks.get(msg.seq);
				if (cb) {
					pendingToolStartAcks.delete(msg.seq);
					cb(msg);
				}
				break;
			}
			case "tool_result": {
				const cb = pendingToolResults.get(msg.seq);
				if (cb) {
					pendingToolResults.delete(msg.seq);
					cb(msg);
				}
				break;
			}
		}
	};

	ctrlIn.on("data", (chunk: Buffer) => {
		if (channelBroken) return;
		let offset = 0;
		while (offset < chunk.length) {
			const nlIndex = chunk.indexOf(0x0a, offset);
			if (nlIndex === -1) {
				const slice = chunk.subarray(offset);
				if (lineBytes + slice.length > MAX_CONTROL_FRAME_BYTES) {
					markChannelBroken();
					ctrlIn.pause();
					return;
				}
				lineChunks.push(Buffer.from(slice));
				lineBytes += slice.length;
				break;
			}
			const slice = chunk.subarray(offset, nlIndex);
			if (lineBytes + slice.length + 1 > MAX_CONTROL_FRAME_BYTES) {
				markChannelBroken();
				ctrlIn.pause();
				return;
			}
			lineChunks.push(Buffer.from(slice));
			const complete = lineChunks.length === 1 ? lineChunks[0] : Buffer.concat(lineChunks, lineBytes + slice.length);
			lineChunks = [];
			lineBytes = 0;
			handleLine(complete);
			offset = nlIndex + 1;
		}
	});
	ctrlIn.on("end", markChannelBroken);
	ctrlIn.on("error", markChannelBroken);
	ctrlOut.on("error", markChannelBroken);

	pi.on("session_shutdown", () => {
		ctrlIn.destroy();
		ctrlOut.end();
	});

	let rejection: string | undefined;
	pi.registerTool({
		name: "clec",
		label: "CLEC",
		description: CLEC_TOOL_DESCRIPTION,
		parameters: Type.Unsafe<unknown>(CLEC_TOOL_PARAMETERS_SCHEMA),
		prepareArguments(args) {
			const decline = rejection;
			rejection = undefined;
			if (decline !== undefined) throw new Error(decline);
			return args;
		},
		executionMode: "sequential",
		execute(toolCallId, params) {
			return new Promise<AgentToolResult<unknown>>((resolve) => {
				try {
					const seq = ++outboundSeq;
					pendingToolResults.set(seq, (res) => {
						if (res.callId !== toolCallId) return;
						resolve({
							content: [{ type: "text", text: res.text }],
							details: {},
							isError: res.isError,
						});
					});
					const ok = sendToOuter({
						kind: "tool_execute",
						seq,
						callId: toolCallId,
						toolName: "clec",
						params,
					});
					if (!ok) {
						pendingToolResults.delete(seq);
					}
				} catch {
					// Keep promise pending while outer terminates
				}
			});
		},
	});

	pi.on("session_start", (_event, ctx) => {
		return new Promise<void>((resolve) => {
			try {
				const activeTools = pi.getActiveTools();
				const allTools = pi.getAllTools();
				const deferredTools = allTools.filter((t) => t.exposure === "deferred").map((t) => t.name);
				const nonBuiltinTools = allTools.filter((t) => t.sourceInfo?.source !== "builtin");
				if (
					activeTools.length !== 1 ||
					activeTools[0] !== "clec" ||
					nonBuiltinTools.length !== 1 ||
					nonBuiltinTools[0].name !== "clec" ||
					nonBuiltinTools[0].exposure !== "direct" ||
					deferredTools.length > 0
				) {
					sendToOuter({
						kind: "adapter_fault_note",
						stage: "session_start",
						detail: `Unexpected tool inventory: active=${JSON.stringify(activeTools)} nonBuiltin=${JSON.stringify(nonBuiltinTools.map((t) => t.name))}`,
					});
					return;
				}
				const seq = ++outboundSeq;
				pendingReadyAck.set(seq, (ack) => {
					if (typeof ack.attemptId === "string" && ack.attemptId.length > 0) {
						boundAttemptId = ack.attemptId;
						lastOuterSeq = ack.seq;
						resolve();
					}
				});
				const sent = sendToOuter({
					kind: "bound_ready",
					seq,
					activeTools,
					allTools: nonBuiltinTools.map((t) => ({
						name: t.name,
						exposure: t.exposure,
						parameters: t.parameters,
					})),
					deferredTools,
					model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
					thinkingLevel: ctx.thinkingLevel ?? null,
				});
				if (!sent) {
					pendingReadyAck.delete(seq);
				}
			} catch {
				// Never settle on error
			}
		});
	});

	pi.on("tool_execution_start", (event) => {
		return new Promise<void>((resolve) => {
			try {
				if (channelBroken || boundAttemptId === null) {
					return;
				}
				const seq = ++outboundSeq;
				pendingToolStartAcks.set(seq, (ack) => {
					if (ack.seq === seq && ack.callId === event.toolCallId && ack.allowed === true) {
						lastOuterSeq = ack.seq;
						rejection = event.toolName === "clec" ? ack.rejection : undefined;
						resolve();
					}
				});
				const sent = sendToOuter({
					kind: "tool_start_observe",
					seq,
					callId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				});
				if (!sent) {
					pendingToolStartAcks.delete(seq);
				}
			} catch {
				// Never reject or resolve on error
			}
		});
	});

	pi.on("before_provider_request", (event) => {
		return new Promise<unknown>((resolve) => {
			try {
				if (channelBroken || boundAttemptId === null) {
					return;
				}
				const { json: payloadJson, byteLength: payloadByteLength } = boundedJsonStringify(
					event.payload,
					MAX_CONTROL_FRAME_BYTES - 4096,
				);
				const payloadDigest = createHash("sha256").update(payloadJson, "utf8").digest("hex");
				const seq = ++outboundSeq;
				const watermark = lastOuterSeq;
				pendingPermits.set(seq, (permit) => {
					if (
						permit.seq === seq &&
						permit.attemptId === boundAttemptId &&
						permit.watermark === watermark &&
						permit.payloadDigest === payloadDigest
					) {
						lastOuterSeq = permit.seq;
						resolve(undefined);
					}
				});
				const sent = sendToOuter({
					kind: "provider_candidate",
					seq,
					watermark,
					payloadDigest,
					payloadByteLength,
					payloadJson,
				});
				if (!sent) {
					pendingPermits.delete(seq);
				}
			} catch (err) {
				try {
					sendToOuter({
						kind: "adapter_fault_note",
						stage: "before_provider_request",
						detail: err instanceof Error ? err.message : String(err),
					});
				} catch {
					// Ignore secondary write error
				}
			}
		});
	});
}
