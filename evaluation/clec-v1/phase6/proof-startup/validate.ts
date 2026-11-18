import { readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { artifactRef, frames, readEvidence } from "./artifacts.ts";
import { parseRawJson, strictUtf8 } from "./framing.ts";
import { sha256Buffer } from "./pins.ts";
import { anchorFor, digest, extractUserContentText, initialAttempt, parsePlan, parseProfile, proofSettings, publicProfile, replacement, runtimeInventory, STATUS_CORPUS, systemPrompt, systemSections, validateProviderPayload,
	type AttemptIdentity, type ExpectedCommitments, type PublicRunPlan } from "./contract.ts";
import type { ExecutionClosure } from "./pins.ts";
import { isDeepStrictEqual } from "node:util";
import { object, PROOF_MODEL } from "./contract.ts";
import { makeCallId, type CallId, UNIT1_LIMITS } from "./types.ts";

export type Mode = "Prefix" | "Closed";

export function requireFact(condition: unknown, invariant: string): asserts condition {
	if (!condition) throw new Error(invariant);
}

export function record(value: unknown, invariant: string): Record<string, unknown> {
	requireFact(object(value), invariant);
	return value;
}

export function equal(actual: unknown, expected: unknown, invariant: string): void {
	requireFact(isDeepStrictEqual(actual, expected), invariant);
}

type CallResult = Readonly<{ text: string; isError: boolean }>;
type Call = {
	readonly id: CallId;
	readonly name: string;
	readonly args: unknown;
	state: "declared" | "started" | "ended" | "recorded";
	result?: CallResult;
};

function resultText(value: unknown): string {
	requireFact(Array.isArray(value) && value.length === 1 && object(value[0]) &&
		value[0].type === "text" && typeof value[0].text === "string", "tool_result_content");
	return value[0].text;
}

function idOf(value: unknown): CallId {
	requireFact(typeof value === "string" && value.length > 0 && value.length <= 256 && Buffer.from(value).toString("utf8") === value, "call_id");
	return makeCallId(value);
}

export class PiProjection {
	readonly calls = new Map<CallId, Call>();
	private stage: "bootstrap" | "prompt" | "agent" | "between" | "turn" | "ended" | "settled" | "idle" = "bootstrap";
	private open: Record<string, unknown> | undefined;
	private assistant: Record<string, unknown> | undefined;
	private readonly messages: string[] = [];
	private turnAssistantIndex = -1;
	private readonly blocks = new Map<number,
		| { kind: "open"; type: string; deltas: string[]; identity: { id: CallId; name: string } | null }
		| { kind: "closed"; block: unknown }>();
	private batch: Call[] = [];
	private readonly completedBatches: Call[][] = [];
	private worked = false;
	private turns = 0;
	private answer: { text: string; stop: string; error: unknown } | null = null;

	private readonly prompt: string;
	private readonly cwd: string | undefined;

	constructor(prompt: string, cwd?: string) {
		this.prompt = prompt;
		this.cwd = cwd;
	}

	get turnCount(): number { return this.turns; }

	get progress() {
		return { stage: this.stage, workObserved: this.worked, calls: this.calls.size };
	}

	finish(mode: Mode, denied?: { id: unknown; name: unknown; ordinal: number }) {
		if (mode === "Closed") {
			if (denied) {
				const calls = [...this.calls.values()];
				const call = calls[denied.ordinal - 1];
				requireFact(this.stage === "turn" && !this.open && this.answer?.stop === "toolUse" &&
					call?.id === denied.id && call?.name === denied.name && call && this.batch.includes(call) &&
					calls.slice(0, denied.ordinal - 1).every(call => call.state === "recorded") &&
					calls.slice(denied.ordinal - 1).every(call => call.state === "declared"), "budget_denial");
			} else {
				requireFact(this.stage === "idle", "pi_lifecycle_incomplete");
				requireFact(this.answer, "missing_answer");
				requireFact([...this.calls.values()].every(call => call.state === "recorded"), "missing_tool_result");
			}
		}
		return { ...this.progress, answer: this.answer };
	}

	historyFor(turn: number): readonly Call[] {
		return this.completedBatches.slice(0, turn).flat();
	}

	accept(value: unknown): void {
		const event = record(value, "pi_event_shape");
		switch (event.type) {
			case "response": {
				const data = record(event.data, "rpc_response");
				requireFact(event.success === true, "rpc_response");
				if (event.id === "prompt-1") {
					requireFact(this.stage === "prompt" && event.command === "prompt" && data.disposition === "started", "rpc_prompt");
					this.stage = "agent";
					return;
				}
				const model = record(data.model, "rpc_model");
				requireFact(event.command === "get_state" && model.provider === PROOF_MODEL.provider && model.id === PROOF_MODEL.model &&
					data.thinkingLevel === PROOF_MODEL.thinking && data.isStreaming === false && data.isCompacting === false &&
					data.pendingMessageCount === 0 && data.sessionFile === undefined && data.autoCompactionEnabled === false, "rpc_state");
				if (event.id === "state-1") {
					requireFact(this.stage === "bootstrap" && data.messageCount === 0, "rpc_bootstrap");
					this.stage = "prompt";
				} else {
					requireFact(event.id === "state-end" && this.stage === "settled" && data.messageCount === this.messages.length, "rpc_idle");
					this.stage = "idle";
				}
				return;
			}
			case "agent_start":
				requireFact(this.stage === "agent", "agent_start_order");
				this.stage = "between";
				return;
			case "turn_start":
				requireFact(this.stage === "between" && (!this.answer || this.answer.stop === "toolUse"), "turn_start_order");
				this.stage = "turn";
				this.turns++;
				this.assistant = undefined;
				this.batch = [];
				this.blocks.clear();
				return;
			case "message_start": {
				const message = record(event.message, "message_shape");
				requireFact(this.stage === "turn" && !this.open, "message_start_order");
				switch (message.role) {
					case "system":
						requireFact(this.messages.length === 0 && !this.assistant, "system_message_order");
						if (this.cwd) {
							requireFact(message.content === "", "system_prompt");
							equal(message.sections, systemSections(this.cwd), "system_prompt");
						}
						break;
					case "user":
						requireFact(this.messages.length === 1 && !this.assistant, "user_message_order");
						equal(resultText(message.content), this.prompt, "question_bytes");
						break;
					case "assistant":
						requireFact(this.messages.length >= 2 && !this.assistant && (message.stopReason === "pending" || message.stopReason === "error"), "assistant_start_order");
						requireFact(Array.isArray(message.content), "assistant_content");
						if (message.content.length > 0) this.worked = true;
						break;
					case "toolResult": {
						const call = this.callFor(message);
						requireFact(call.state === "ended", "tool_result_order");
						equal(this.readResult(message), call.result, "tool_result_pairing");
						break;
					}
					default: throw new Error("message_role");
				}
				this.open = message;
				return;
			}
			case "message_update":
				this.update(event);
				return;
			case "message_end":
				this.endMessage(record(event.message, "message_shape"));
				return;
			case "tool_execution_start": {
				requireFact(this.stage === "turn" && this.assistant && !this.open, "tool_start_order");
				const call = this.callFor(event);
				requireFact(call.state === "declared", "duplicate_tool_start");
				equal(event.args, call.args, "tool_start_args");
				call.state = "started";
				return;
			}
			case "tool_execution_end": {
				requireFact(this.stage === "turn" && this.assistant && !this.open, "tool_end_order");
				const call = this.callFor(event);
				requireFact(call.state === "started" && typeof event.isError === "boolean", "tool_end_order");
				call.result = { text: resultText(record(event.result, "tool_result_shape").content), isError: event.isError };
				call.state = "ended";
				return;
			}
			case "turn_end":
				requireFact(this.stage === "turn" && !this.open, "turn_end_order");
				requireFact(this.assistant, "missing_answer");
				requireFact(this.batch.every(call => call.state === "recorded"), "missing_tool_result");
				equal(event.message, this.assistant, "turn_assistant_mismatch");
				requireFact(Array.isArray(event.toolResults), "turn_tool_results");
				equal(event.toolResults.map(digest), this.messages.slice(this.turnAssistantIndex + 1), "turn_tool_results");
				this.completedBatches.push(this.batch);
				this.stage = "between";
				return;
			case "agent_end":
				requireFact(this.stage === "between" && this.answer && this.answer.stop !== "toolUse" && event.willRetry === false, "agent_end_order");
				requireFact(Array.isArray(event.messages), "agent_messages");
				equal(event.messages.map(digest), this.messages, "agent_messages");
				this.stage = "ended";
				return;
			case "agent_settled":
				requireFact(this.stage === "ended" && event.aborted === false, "agent_settled_order");
				this.stage = "settled";
				return;
			default: throw new Error("pi_event_kind");
		}
	}

	private update(event: Record<string, unknown>): void {
		requireFact(this.stage === "turn" && this.open?.role === "assistant", "assistant_update_order");
		const update = record(event.assistantMessageEvent, "assistant_update_shape");
		requireFact(typeof update.type === "string" && Number.isSafeInteger(update.contentIndex) && typeof update.contentIndex === "number" &&
			update.contentIndex >= 0, "assistant_update_shape");
		const [kind, transition] = update.type.split("_");
		requireFact(["text", "thinking", "toolcall"].includes(kind) && update.type === `${kind}_${transition}`, "assistant_update_kind");
		this.worked = true;
		const index = update.contentIndex;
		const block = this.blocks.get(index);
		if (transition === "start") {
			requireFact(!block && index === this.blocks.size, "assistant_delta_order");
			let identity = null;
			if (kind === "toolcall") {
				requireFact(typeof update.toolName === "string", "assistant_delta_content");
				identity = { id: idOf(update.id), name: update.toolName };
			}
			this.blocks.set(index, { kind: "open", type: kind, deltas: [], identity });
			return;
		}
		requireFact(block?.kind === "open" && block.type === kind, "assistant_delta_order");
		if (transition === "delta") {
			requireFact(typeof update.delta === "string", "assistant_delta_content");
			block.deltas.push(update.delta);
			return;
		}
		requireFact(transition === "end", "assistant_update_kind");
		let content: unknown;
		if (kind === "toolcall") {
			const call = record(update.toolCall, "assistant_delta_content");
			requireFact(call.type === "toolCall" && call.id === block.identity?.id && call.name === block.identity?.name,
				"assistant_delta_content");
			content = call;
		} else {
			equal(update.content, block.deltas.join(""), "assistant_delta_content");
			content = kind === "text" ? { type: "text", text: update.content } : { type: "thinking", thinking: update.content };
		}
		this.blocks.set(index, { kind: "closed", block: content });
	}

	private endMessage(message: Record<string, unknown>): void {
		requireFact(this.stage === "turn" && this.open?.role === message.role && this.open, "message_end_order");
		if (message.role === "assistant") {
			requireFact(Array.isArray(message.content), "assistant_content");
			requireFact(["toolUse", "stop", "length", "error", "aborted", "contentFilter"].some(reason => reason === message.stopReason) &&
				typeof message.stopReason === "string" && message.provider === PROOF_MODEL.provider && message.model === PROOF_MODEL.model,
				"assistant_stop");
			this.assistant = message;
			this.turnAssistantIndex = this.messages.length;
			equal(message.content.map(value => {
				const block = record(value, "assistant_content");
				return block.type === "thinking" ? { type: "thinking", thinking: block.thinking } : block;
			}), Array.from(this.blocks.values(), block => {
				requireFact(block.kind === "closed", "assistant_delta_order");
				return block.block;
			}), "assistant_content_mismatch");
			const text: string[] = [];
			for (const value of message.content) {
				const block = record(value, "assistant_content");
				this.worked = true;
				switch (block.type) {
					case "text":
						requireFact(typeof block.text === "string", "assistant_text");
						text.push(block.text);
						break;
					case "thinking":
						requireFact(typeof block.thinking === "string", "assistant_thinking");
						break;
					case "toolCall": {
						const id = idOf(block.id);
						requireFact(!this.calls.has(id), "duplicate_call");
						requireFact(typeof block.name === "string" && block.name.length > 0 && object(block.arguments), "call_declaration");
						const call: Call = { id, name: block.name, args: block.arguments, state: "declared" };
						this.calls.set(id, call);
						this.batch.push(call);
						break;
					}
					default: throw new Error("assistant_content_kind");
				}
			}
			requireFact((message.stopReason === "toolUse") === (this.batch.length > 0), "assistant_tool_stop");
			const joined = text.join("");
			requireFact(Buffer.byteLength(joined) <= UNIT1_LIMITS.answerBytes && Buffer.from(joined).toString("utf8") === joined, "assistant_answer_bytes");
			this.answer = { text: joined, stop: message.stopReason, error: message.errorMessage ?? null };
		} else {
			equal(message, this.open, "message_end_mismatch");
			if (message.role === "toolResult") this.callFor(message).state = "recorded";
		}
		this.messages.push(digest(message));
		this.open = undefined;
	}

	private callFor(value: Record<string, unknown>): Call {
		const call = this.calls.get(idOf(value.toolCallId));
		requireFact(call && this.batch.includes(call) && call.name === value.toolName, "unpaired_call");
		return call;
	}

	private readResult(value: Record<string, unknown>): CallResult {
		requireFact(typeof value.isError === "boolean", "tool_result_shape");
		return { text: resultText(value.content), isError: value.isError };
	}
}

function unsigned(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function checkStop(value: unknown): void {
	const stop = record(value, "process_closure");
	const drain = record(stop.drain, "process_drain");
	requireFact(drain.kind === "drained" && finite(stop.triggerAt) && finite(stop.reapedAt) &&
		finite(stop.observationCompletedAt) && finite(stop.drainDeadline) && finite(stop.observationDeadline) &&
		stop.drainDeadline <= stop.triggerAt + UNIT1_LIMITS.killGraceMs &&
		stop.observationDeadline <= stop.triggerAt + UNIT1_LIMITS.killGraceMs &&
		stop.reapedAt <= stop.observationDeadline && stop.observationCompletedAt <= stop.observationDeadline &&
		(stop.killAttemptAt === null || (finite(stop.killAttemptAt) && stop.killAttemptAt >= stop.triggerAt &&
			stop.killAttemptAt <= stop.triggerAt + UNIT1_LIMITS.killGraceMs)) && stop.killError === null, "process_closure");
}

function attemptPaths(identity: AttemptIdentity) {
	const attempt = `attempts/${identity.attemptId}`;
	return { attempt, capture: `${attempt}/capture`, settings: `${attempt}/agent/settings.json` };
}

const baseArtifacts = [
	["journal.jsonl", "journal", UNIT1_LIMITS.journalTotalBytes],
	["pi.stdout.jsonl", "pi_stdout", UNIT1_LIMITS.piStdoutBytes],
	["pi.stderr.bin", "pi_stderr", UNIT1_LIMITS.piStderrBytes],
	["question.bin", "question", UNIT1_LIMITS.answerBytes],
	["loopback.json", "loopback", UNIT1_LIMITS.controlAggregateBytes],
] as const;
const nativeArtifacts = [
	["stdout.bin", "native_stdout", UNIT1_LIMITS.nativeStdoutBytes],
	["stderr.bin", "native_stderr", UNIT1_LIMITS.nativeStderrBytes],
	["chunks.jsonl", "native_chunks", UNIT1_LIMITS.controlFrameBytes],
] as const;

export function snapshotArtifacts(root: string, identity: AttemptIdentity) {
	const { capture, settings } = attemptPaths(identity);
	const assets: [string, string, number][] = [
		...baseArtifacts.map(([file, role, cap]): [string, string, number] => [`${capture}/${file}`, role, cap]),
		[settings, "settings", UNIT1_LIMITS.controlFrameBytes],
	];
	for (const name of readdirSync(join(root, capture)).sort()) {
		for (const [suffix, role, cap] of nativeArtifacts) {
			if (new RegExp(`^lease-[1-8]\\.native\\.${suffix.replace(".", "\\.")}$`).test(name)) {
				assets.push([`${capture}/${name}`, role, cap]);
			}
		}
	}
	return assets.map(([path, role, cap]) => artifactRef(path, role, readEvidence(root, path, cap)));
}

class ObservedArtifacts {
	private readonly remaining = new Map<string, Record<string, unknown>>();
	private readonly root: string;

	constructor(root: string, refs: unknown) {
		this.root = root;
		requireFact(Array.isArray(refs), "artifact_inventory");
		for (const item of refs) {
			const ref = record(item, "artifact_ref");
			requireFact(typeof ref.path === "string" && !this.remaining.has(ref.path), "duplicate_artifact");
			this.remaining.set(ref.path, ref);
		}
	}

	take(path: string, role: string, cap: number): Buffer {
		const ref = this.remaining.get(path);
		requireFact(ref, "missing_artifact");
		const bytes = readEvidence(this.root, path, cap);
		equal(ref, artifactRef(path, role, bytes), "artifact_ref");
		this.remaining.delete(path);
		return bytes;
	}

	finish(): void { requireFact(this.remaining.size === 0, "unobserved_artifact"); }
}

type Body = Record<string, unknown>;
type JournalEvent = Record<string, unknown> & { kind: string; body: Body };

function attemptRecords(bytes: Buffer, anchor: ExpectedCommitments, id: AttemptIdentity): JournalEvent[] {
	const events: JournalEvent[] = [];
	let time = 0;
	for (const { value } of frames(bytes, UNIT1_LIMITS.journalTotalBytes)) {
		const event = record(value, "journal_record");
		requireFact(event.runId === anchor.runId && event.attemptId === id.attemptId &&
			event.seq === events.length + 1 && typeof event.kind === "string" && finite(event.monotonicMs) &&
			event.monotonicMs >= time && typeof event.utcIso === "string" && !Number.isNaN(Date.parse(event.utcIso)), "journal_envelope");
		time = event.monotonicMs;
		events.push({ ...event, kind: event.kind, body: record(event.body, "journal_body") });
	}
	return events;
}

function checkChunks(bytes: Buffer, stdout: Buffer, stderr: Buffer, started: JournalEvent, exited: JournalEvent): void {
	const streams = { stdout, stderr };
	const offsets = { stdout: 0, stderr: 0 };
	let previous = Number(started.monotonicMs);
	for (const { value } of frames(bytes)) {
		const chunk = record(value, "native_chunk");
		const stream = chunk.stream;
		requireFact((stream === "stdout" || stream === "stderr") && unsigned(chunk.bytes) && chunk.bytes > 0 &&
			finite(chunk.monotonicMs) && chunk.monotonicMs >= previous && chunk.monotonicMs <= Number(exited.monotonicMs) &&
			chunk.runId === started.runId && chunk.attemptId === started.attemptId &&
			chunk.callId === started.body.callId && chunk.leaseId === started.body.leaseId, "native_chunk");
		const offset = offsets[stream];
		const end = offset + chunk.bytes;
		requireFact(chunk.offset === offset && end <= streams[stream].length &&
			chunk.sha256 === sha256Buffer(streams[stream].subarray(offset, end)), "native_chunk_range");
		offsets[stream] = end;
		previous = chunk.monotonicMs;
	}
	requireFact(offsets.stdout === stdout.length && offsets.stderr === stderr.length, "native_chunk_coverage");
}

const groupKinds = ["group_reserved", "group_registered", "group_go_sent", "native_pid_reported", "native_exited", "tool_result_delivered", "group_closure_observed"];

function checkGroup(input: {
	events: JournalEvent[]; call: Call; ordinal: number; artifacts: ObservedArtifacts; capture: string; nativePath: string; originalRoot: string;
}): Readonly<{ nativePid: number; pgid: number }> {
	const { events, call, ordinal, artifacts, capture, nativePath, originalRoot } = input;
	const lease = `lease-${ordinal}`;
	requireFact(events.length === groupKinds.length, "native_lifecycle");
	const bodies = events.map((event, i) => {
		requireFact(event.kind === groupKinds[i] && event.body.leaseId === lease &&
			(event.kind === "group_closure_observed" || event.body.callId === call.id), "native_lifecycle");
		return event.body;
	});
	const [, registration, go, started, exit, delivered, closure] = bodies;
	const pgid = registration.pgid;
	const nativePid = started.nativePid;
	requireFact(unsigned(pgid) && pgid > 0 && registration.helperPid === pgid && typeof registration.helperLstart === "string" &&
		registration.sentinelAbsentAtRegistration !== false, "native_registration");
	const dataDir = join(originalRoot, capture, "..", "data");
	equal(go, {
		leaseId: lease, callId: call.id, execPath: nativePath, stdin: "empty",
		argv: ["--data-dir", dataDir, "--offline", "--json", "status"],
	}, "native_invocation");
	requireFact(unsigned(nativePid) && nativePid > 0 && started.pgid === pgid && nativePid !== pgid &&
		(started.observedPgid === null || started.observedPgid === pgid), "native_pid");
	const observation = record(closure.observation, "native_observation");
	requireFact(observation.kind === "gone" && observation.pgid === pgid && finite(observation.checkedAtMonotonicMs), "native_observation");
	equal(observation.pidsChecked, [pgid, nativePid], "native_observation");
	checkStop(closure.stop);
	const [stdout, stderr, chunks] = nativeArtifacts.map(([file, role, cap]) =>
		artifacts.take(`${capture}/${lease}.native.${file}`, role, cap));
	checkChunks(chunks, stdout, stderr, events[3], events[4]);
	requireFact((unsigned(exit.exitCode) && exit.signal === null) ||
		(exit.exitCode === null && typeof exit.signal === "string" && exit.signal.startsWith("SIG")), "native_exit");
	const success = exit.exitCode === 0;
	const text = success ? strictUtf8(stdout) : JSON.stringify({ ok: false, error: `Native exited code=${exit.exitCode} signal=${exit.signal}` });
	if (success) {
		const status = record(parseRawJson(stdout), "corpus_postcheck");
		const data = record(status.data, "corpus_postcheck");
		requireFact(status.ok === true && status.command === "status" && data.offline === true && data.ready === false &&
			data.activeRelease === null && data.manifestPath === null && data.storageBytes === 0 && data.dataDir === dataDir, "corpus_postcheck");
	}
	equal(call.result, { text, isError: !success }, "native_model_bytes");
	requireFact(delivered.isError === !success && delivered.resultSha256 === sha256Buffer(text) &&
		delivered.stdoutBytes === Buffer.byteLength(stdout.toString("utf8")) &&
		delivered.stderrBytes === Buffer.byteLength(stderr.toString("utf8")), "delivered_result");
	return { nativePid, pgid };
}

function providerRequests(events: JournalEvent[], prompt: string, cwd: string, seen: unknown, pi: PiProjection) {
	requireFact(Array.isArray(seen), "loopback_capture");
	let pending: { candidate: Body; granted: boolean } | null = null;
	let used = 0;
	let seq = 1;
	let watermark = 1;
	const outcomes: string[] = [];

	for (const { kind, body } of events) {
		switch (kind) {
			case "tool_start_reserved":
				requireFact(!pending && unsigned(body.bridgeSeq) && body.bridgeSeq > seq, "bridge_sequence");
				used++;
				seq = watermark = body.bridgeSeq;
				break;
			case "provider_candidate": {
				const { payloadJson } = body;
				requireFact(!pending && unsigned(body.seq) && body.seq > seq && body.watermark === watermark &&
					typeof payloadJson === "string" && body.payloadDigest === sha256Buffer(payloadJson) &&
					body.payloadByteLength === Buffer.byteLength(payloadJson), "provider_candidate");
				requireFact(validateProviderPayload({ payloadJson, expectedModelId: PROOF_MODEL.model, expectedEncodedPrompt: prompt, expectedSystemPrompt: systemPrompt(cwd) }).ok, "provider_profile");
				pending = { candidate: body, granted: false };
				seq = body.seq;
				break;
			}
			case "provider_grant":
				requireFact(pending && !pending.granted && body.seq === pending.candidate.seq &&
					body.watermark === pending.candidate.watermark && body.payloadDigest === pending.candidate.payloadDigest &&
					body.attemptsUsedSoFar === used && used <= UNIT1_LIMITS.maxAttempts, "provider_grant");
				pending.granted = true;
				break;
			case "provider_permit_sent": {
				requireFact(pending?.granted && body.seq === pending.candidate.seq &&
					body.payloadDigest === pending.candidate.payloadDigest, "provider_permit");
				const wire = record(seen[outcomes.length], "missing_loopback_request");
				requireFact(wire.seq === outcomes.length + 1 && wire.method === "POST" &&
					wire.url === "/v1/chat/completions" && typeof wire.bodyText === "string" &&
					["text", "tool_calls", "transport_reset", "http_error"].some(kind => kind === wire.outcome) &&
					typeof wire.outcome === "string" && typeof pending.candidate.payloadJson === "string", "loopback_capture");
				const payload = record(JSON.parse(pending.candidate.payloadJson), "provider_candidate");
				equal(JSON.parse(wire.bodyText), payload, "wire_payload");
				requireFact(Array.isArray(payload.messages), "provider_messages");
				const resultIds: CallId[] = [];
				for (const value of payload.messages) {
					const message = record(value, "provider_messages");
					if (message.role === "tool") {
						const call = pi.calls.get(idOf(message.tool_call_id));
						requireFact(call?.result && extractUserContentText(message.content) === call.result.text, "provider_tool_result");
						resultIds.push(call.id);
					}
				}
				equal(resultIds, pi.historyFor(outcomes.length).map(call => call.id), "provider_tool_history");
				outcomes.push(wire.outcome);
				pending = null;
				break;
			}
		}
	}
	requireFact(!pending && seen.length === outcomes.length && outcomes.length > 0, "provider_request_coverage");
	requireFact(outcomes.length === pi.turnCount, "provider_turn_coverage");
	return outcomes;
}

function validateAttempt(params: {
	root: string; originalRoot: string; anchor: ExpectedCommitments; plan: PublicRunPlan; closure: Body; adapterPath: string;
	identity: AttemptIdentity; artifacts: unknown; question: PublicRunPlan["cases"][number];
}) {
	const { root, originalRoot, anchor, plan, closure, identity, question } = params;
	const { attempt, capture, settings } = attemptPaths(identity);
	const cwd = join(originalRoot, attempt, "cwd");
	const artifacts = new ObservedArtifacts(root, params.artifacts);
	const [journal, stdout, , questionBytes, wire] = baseArtifacts.map(([file, role, cap]) =>
		artifacts.take(`${capture}/${file}`, role, cap));
	equal(questionBytes, Buffer.from(question.question), "question_bytes");
	const settingsBytes = artifacts.take(settings, "settings", UNIT1_LIMITS.controlFrameBytes);
	const actualSettings = parseRawJson(settingsBytes);
	equal(sha256Buffer(settingsBytes), plan.profile.settings, "settings_pin");
	equal(actualSettings, proofSettings(PROOF_MODEL.provider, PROOF_MODEL.model, PROOF_MODEL.thinking), "settings_pin");
	const events = attemptRecords(journal, anchor, identity);
	const byKind = (kind: string) => events.filter(event => event.kind === kind);
	const one = (kind: string) => {
		const items = byKind(kind);
		requireFact(items.length === 1, `journal_${kind}`);
		return items[0];
	};
	const prompt = UNIT1_LIMITS.promptPrefix + question.question;
	equal(events[0]?.kind, "plan_committed", "attempt_open");
	equal(events[0].body, {
		caseLabel: question.id, plan: anchor.plan, identity, toolProfile: UNIT1_LIMITS.toolProfile, limits: UNIT1_LIMITS, corpusBefore: STATUS_CORPUS,
		originalQuestionSha256: question.questionSha256, encodedPromptSha256: sha256Buffer(prompt),
	}, "attempt_plan");
	const pins = one("closure_verified");
	requireFact(pins.seq === 2, "runtime_pin_order");
	const { nativePath, ...pinsExpected } = closure;
	equal(pins.body, pinsExpected, "attempt_pins");

	const pi = new PiProjection(prompt, cwd);
	const rawRefs = byKind("pi_frame");
	let frameCount = 0;
	for (const frame of frames(stdout)) {
		pi.accept(frame.value);
		equal(rawRefs[frameCount]?.body, frame.range, "pi_frame_range");
		frameCount++;
	}
	const denials = byKind("tool_start_denied");
	requireFact(denials.length <= 1, "budget_denial");
	const denial = denials[0]?.body;
	const deniedOrdinal = UNIT1_LIMITS.maxAttempts + 1;
	if (denial) requireFact(denial.reason === "attemptBudgetExceeded" && denial.ordinal === deniedOrdinal &&
		denial.maxAttempts === UNIT1_LIMITS.maxAttempts &&
		!events.slice(events.indexOf(denials[0]) + 1).some(event => event.kind === "provider_permit_sent"), "budget_denial");
	const piClosed = pi.finish("Closed", denial && { id: denial.callId, name: denial.toolName, ordinal: deniedOrdinal });
	requireFact(frameCount === rawRefs.length && piClosed.answer, "pi_frame_coverage");

	const ready = one("bound_ready").body;
	equal(ready, {
		seq: 1, activeTools: ["clec"], deferredTools: [],
		model: { provider: PROOF_MODEL.provider, id: PROOF_MODEL.model }, thinkingLevel: PROOF_MODEL.thinking,
	}, "bound_ready");
	equal(one("bound_ready_ack").body, { seq: 1 }, "bound_ready_ack");
	equal(one("get_state_ok").body, {
		modelProvider: PROOF_MODEL.provider, modelId: PROOF_MODEL.model, thinkingLevel: PROOF_MODEL.thinking, autoCompactionEnabled: false,
	}, "initial_state");
	equal(one("prompt_encoded").body, {
		originalQuestionSha256: question.questionSha256, encodedPromptSha256: sha256Buffer(prompt), encodedByteLength: Buffer.byteLength(prompt),
	}, "prompt_encoded");
	equal(one("prompt_sent").body, { id: "prompt-1", message: prompt }, "prompt_sent");
	equal(one("prompt_preflight").body, { disposition: "started" }, "prompt_preflight");
	if (!denial) equal(one("agent_settled").body, { aborted: false }, "agent_settled");
	const lifecycle = ["plan_committed", "closure_verified", "pi_spawned", "bound_ready", "bound_ready_ack", "get_state_ok",
		"prompt_encoded", "prompt_sent", "prompt_preflight", ...(denial ? ["tool_start_denied"] : ["agent_settled"]),
		"pi_exited", "attempt_closed"];
	const lifecycleSet = new Set(lifecycle);
	equal(events.filter(event => lifecycleSet.has(event.kind)).map(event => event.kind), lifecycle, "journal_lifecycle");
	const supported = new Set([...lifecycle, ...groupKinds, "pi_frame", "provider_candidate", "provider_grant",
		"provider_permit_sent", "tool_declared_batch", "tool_start_reserved"]);
	requireFact(events.every(event => supported.has(event.kind)), "journal_invalid_evidence");
	const spawned = one("pi_spawned").body;
	requireFact(unsigned(spawned.pid) && spawned.pid > 0 && typeof spawned.lstart === "string" && spawned.adapterPath === params.adapterPath, "pi_pid");
	const exited = one("pi_exited").body;
	const piStop = record(exited.stop, "pi_exit");
	requireFact(denial
		? exited.code === null && (exited.signal === "SIGKILL" ? finite(piStop.killAttemptAt)
			: exited.signal === "SIGTERM" && finite(piStop.termAttemptAt))
		: exited.code === 0 && exited.signal === null, "pi_exit");
	checkStop(piStop);

	const reservations = byKind("tool_start_reserved");
	const declared = byKind("tool_declared_batch").flatMap(({ body }) => {
		requireFact(Array.isArray(body.calls) && body.calls.length > 0, "tool_declarations");
		return body.calls;
	});
	const calls = Array.from(pi.calls.values());
	equal(declared, calls.map(({ id, name }) => ({ id, name })), "tool_declarations");
	requireFact(reservations.length === (denial ? UNIT1_LIMITS.maxAttempts : calls.length) &&
		reservations.length <= UNIT1_LIMITS.maxAttempts, "tool_reservation_coverage");
	const groups = new Map<string, JournalEvent[]>();
	for (const event of events.filter(event => groupKinds.includes(event.kind))) {
		const { leaseId } = event.body;
		requireFact(typeof leaseId === "string", "native_lease");
		const group = groups.get(leaseId) ?? [];
		group.push(event);
		groups.set(leaseId, group);
	}
	const callSummary = calls.map((call, i) => {
		const ordinal = i + 1;
		const reservation = reservations[i];
		if (denial && !reservation) {
			return { id: call.id, name: call.name, ordinal: ordinal === deniedOrdinal ? ordinal : null,
				result: null, native: null };
		}
		requireFact(reservation.body.callId === call.id && reservation.body.toolName === call.name &&
			reservation.body.ordinal === ordinal, "tool_reservation");
		const lease = `lease-${ordinal}`;
		const group = groups.get(lease);
		groups.delete(lease);
		const executable = call.name === "clec" && object(call.args) && Object.keys(call.args).length === 1 && call.args.action === "status";
		const native = executable ? checkGroup({
			events: group ?? [], call, ordinal, artifacts, capture,
			nativePath: String(nativePath), originalRoot,
		}) : null;
		if (executable) requireFact(Number(group?.[0]?.seq) > Number(reservation.seq), "native_reservation_order");
		else requireFact(!group && call.result?.isError === true, "invalid_tool_rejection");
		return { id: call.id, name: call.name, ordinal, result: call.result, native };
	});
	requireFact(groups.size === 0, "unpaired_native");
	artifacts.finish();

	const outcomes = providerRequests(events, prompt, cwd, parseRawJson(wire), pi);
	const answer = piClosed.answer;
	const transport = outcomes.length === 1 && outcomes[0] === "transport_reset";
	const eligible = transport && !piClosed.workObserved && calls.length === 0 && answer.stop === "error" &&
		answer.text.length === 0 && typeof answer.error === "string" && answer.error.includes("UND_ERR_SOCKET");
	requireFact(!transport || eligible, "transport_witness");
	const status = denial ? "DeniedAndTerminated" : answer.stop === "stop" && answer.text.trim().length > 0 ? "Answered"
		: eligible ? "PreWorkInfrastructureFailed" : "TaskFailed";
	const rawClosed = one("attempt_closed");
	requireFact(rawClosed === events.at(-1) && rawClosed.body.uncertified === false, "attempt_terminal");
	equal(rawClosed.body.status, status === "PreWorkInfrastructureFailed" ? "TaskFailed" : status, "attempt_status");
	equal(rawClosed.body.nativeStarts, callSummary.filter(call => call.native).length, "native_count");
	equal(rawClosed.body.providerRequestsGranted, outcomes.length, "provider_count");
	equal(rawClosed.body.providerRequestsDenied, 0, "provider_denied_count");
	return { identity, status, answer, workObserved: piClosed.workObserved, providerRequests: outcomes.length, calls: callSummary, piPid: spawned.pid };
}

type AttemptSummary = ReturnType<typeof validateAttempt>;
export type RunSummary = Readonly<{
	version: 1; runId: ExpectedCommitments["runId"]; plan: ExpectedCommitments["plan"]; profile: ExpectedCommitments["profile"];
	attemptCount: number; replacementsUsed: number; status: "Answered" | "TaskFailed";
	attempts: readonly AttemptSummary[];
}>;
export type Validation =
	| { readonly kind: "Invalid"; readonly invariant: string }
	| { readonly kind: "Incomplete"; readonly attempts: readonly AttemptSummary[]; readonly next: AttemptIdentity | null; readonly invariant: string }
	| { readonly kind: "Complete"; readonly summary: RunSummary };

type RuntimeWitness = Readonly<{ profile: PublicRunPlan["profile"]; inventory: ReturnType<typeof runtimeInventory> }>;

export function runtimeWitness(closure: ExecutionClosure): RuntimeWitness {
	return { profile: publicProfile(closure), inventory: runtimeInventory(closure) };
}

function validateRun(root: string, expected: ExpectedCommitments, mode: Mode): Validation {
	const planBytes = readEvidence(root, "plan.json", UNIT1_LIMITS.controlFrameBytes);
	const planInput = parseRawJson(planBytes);
	const stream = readEvidence(root, "run.jsonl", UNIT1_LIMITS.journalTotalBytes);
	const entries = frames(stream);
	const open = record(entries.next().value?.value, "run_open");
	const witness = record(open.witness, "runtime_witness");
	const planRecord = record(planInput, "plan_shape");
	requireFact(sha256Buffer(planBytes) === expected.plan && digest(planRecord.profile) === expected.profile &&
		digest(witness.profile) === expected.profile, "external_anchor");
	const profile = parseProfile(witness.profile);
	const plan = parsePlan(planInput, profile);
	equal(anchorFor(expected.runId, plan, expected.originalRoot), expected, "external_anchor");
	const inventory = record(witness.inventory, "runtime_witness");
	const native = record(inventory.nativePin, "runtime_witness");
	const skill = record(inventory.skillPin, "runtime_witness");
	const piEntry = record(inventory.piEntryPin, "runtime_witness");
	requireFact(digest(inventory) === profile.runtimeIdentity && digest(inventory.unit1Files) === profile.source &&
		inventory.closureDigest === profile.runtime && skill.sha256 === profile.skill &&
		typeof native.canonicalPath === "string" && isAbsolute(native.canonicalPath), "runtime_witness");
	requireFact(Array.isArray(inventory.unit1Files), "runtime_witness");
	const adapter = inventory.unit1Files.find((file: unknown) => object(file) &&
		typeof file.logicalPath === "string" && file.logicalPath.endsWith("/clec-adapter.ts"));
	requireFact(object(adapter) && typeof adapter.logicalPath === "string", "runtime_witness");
	const closure = {
		closureDigest: inventory.closureDigest, nativeOrigin: inventory.nativeSourceOrigin, nativeSha256: native.sha256,
		skillOrigin: inventory.skillSourceOrigin, skillSha256: skill.sha256, piEntrySha256: piEntry.sha256,
		piTreeSha256: inventory.piTreeSha256, nativePath: native.canonicalPath,
	};
	requireFact(open.kind === "run_open" && open.seq === 1 && open.plan === expected.plan && open.runId === expected.runId &&
		open.originalRoot === expected.originalRoot, "run_open");
	let seq = 1;
	let caseIndex = 0;
	let replacements = 0;
	let next: AttemptIdentity | null = initialAttempt(expected.runId, plan.cases[0].id);
	const attempts: AttemptSummary[] = [];
	let terminal = false;
	for (const frame of entries) {
		const entry = record(frame.value, "run_record");
		requireFact(!terminal && entry.seq === ++seq && entry.plan === expected.plan && entry.runId === expected.runId, "run_lifecycle");
		if (entry.kind === "run_closed") {
			requireFact(next === null && caseIndex === plan.cases.length, attempts.length ? "scheduled_case_missing" : "empty_attempts");
			equal(entry.witness, witness, "closure_postcheck");
			terminal = true;
			continue;
		}
		requireFact(entry.kind === "attempt", "run_record_kind");
		const id = record(entry.identity, "attempt_identity");
		requireFact(id.ordinal === 1 || id.ordinal === 2, "attempt_ordinal");
		requireFact(!attempts.some(attempt => attempt.identity.attemptId === id.attemptId), "duplicate_attempt");
		if (id.ordinal === 2) requireFact(replacements === 0 && next?.ordinal === 2, "unexpected_reattempt");
		requireFact(next, "unscheduled_attempt");
		requireFact(id.predecessor === next.predecessor, "replacement_predecessor");
		equal(id, next, "case_order");
		equal(entry.witness, witness, "closure_postcheck");
		equal(entry.corpusAfter, STATUS_CORPUS, "corpus_postcheck");
		const result = validateAttempt({
			root, originalRoot: expected.originalRoot, anchor: expected, plan,
			identity: next, question: plan.cases[caseIndex], closure, adapterPath: adapter.logicalPath,
			artifacts: entry.artifacts,
		});
		attempts.push(result);
		if (next.ordinal === 2) replacements++;
		if (next.ordinal === 1 && replacements === 0 && result.status === "PreWorkInfrastructureFailed") {
			next = replacement(expected.runId, next);
		} else {
			const upcoming = plan.cases[++caseIndex];
			next = upcoming ? initialAttempt(expected.runId, upcoming.id) : null;
		}
	}
	if (mode === "Prefix") return { kind: "Incomplete", attempts, next, invariant: next ? "schedule_pending" : "seal_pending" };
	if (!terminal) return { kind: "Incomplete", attempts, next, invariant: attempts.length === 0 ? "empty_attempts" : next ? "scheduled_case_missing" : "run_not_closed" };
	const summary: RunSummary = {
		version: 1, runId: expected.runId, plan: expected.plan, profile: expected.profile, attemptCount: attempts.length,
		replacementsUsed: replacements, status: plan.cases.every(c => attempts.findLast(a => a.identity.caseId === c.id)?.status === "Answered")
			? "Answered" : "TaskFailed", attempts,
	};
	return { kind: "Complete", summary };
}

export function reconcile(root: string, expected: ExpectedCommitments, mode: Mode): Validation {
	try { return validateRun(root, expected, mode); }
	catch (err) { return { kind: "Invalid", invariant: err instanceof Error ? err.message : String(err) }; }
}


export function summaryEnvelope(summary: RunSummary) {
	return { summary, sha256: digest(summary) };
}

export function inspectRun(root: string, expected: ExpectedCommitments): Validation {
	const result = reconcile(root, expected, "Closed");
	if (result.kind !== "Complete") return result;
	try {
		const saved = parseRawJson(readEvidence(root, "summary.json", UNIT1_LIMITS.journalTotalBytes));
		equal(saved, summaryEnvelope(result.summary), "derived_summary");
		return result;
	} catch (error) {
		return { kind: "Invalid", invariant: error instanceof Error ? error.message : String(error) };
	}
}
