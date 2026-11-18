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
import { STOP_GRACE_MS } from "./process-group.ts";
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
type Answer = Readonly<{ text: string; stop: string; error: unknown }>;
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
	private readonly turns: { start: number; response: number; answer: Answer; calls: Call[] }[] = [];
	private worked = false;
	private frameIndex = -1;
	private turnStart = -1;
	private responseStart = -1;
	private answer: Answer | null = null;
	private bootstrap: { frame: number; sessionId: string; baseUrl: string; model: Record<string, unknown> } | null = null;
	private promptFrame: number | null = null;
	private idleFrame: number | null = null;

	private readonly prompt: string;
	private readonly cwd: string | undefined;

	constructor(prompt: string, cwd?: string) {
		this.prompt = prompt;
		this.cwd = cwd;
	}

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
		return {
			...this.progress, answer: this.answer, bootstrap: this.bootstrap, promptFrame: this.promptFrame, idleFrame: this.idleFrame,
			turns: this.turns.map(turn => ({
				...turn, calls: turn.calls.map(({ id, name, args, result }) => ({ id, name, args, result: result ?? null })),
			})),
		};
	}

	accept(value: unknown): void {
		this.frameIndex++;
		const event = record(value, "pi_event_shape");
		switch (event.type) {
			case "response": {
				const data = record(event.data, "rpc_response");
				requireFact(event.success === true, "rpc_response");
				if (event.id === "prompt-1") {
					requireFact(this.stage === "prompt" && event.command === "prompt" && data.disposition === "started", "rpc_prompt");
					this.promptFrame = this.frameIndex;
					this.stage = "agent";
					return;
				}
				const model = record(data.model, "rpc_model");
				requireFact(event.command === "get_state" && model.provider === PROOF_MODEL.provider && model.id === PROOF_MODEL.model &&
					model.api === "openai-completions" && typeof model.baseUrl === "string" &&
					typeof data.sessionId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(data.sessionId) &&
					data.thinkingLevel === PROOF_MODEL.thinking && data.isStreaming === false && data.isCompacting === false &&
					data.pendingMessageCount === 0 && data.sessionFile === undefined && data.autoCompactionEnabled === false, "rpc_state");
				if (event.id === "state-1") {
					requireFact(this.stage === "bootstrap" && data.messageCount === 0, "rpc_bootstrap");
					this.bootstrap = { frame: this.frameIndex, sessionId: data.sessionId, baseUrl: model.baseUrl, model };
					this.stage = "prompt";
				} else {
					requireFact(event.id === "state-end" && this.stage === "settled" && data.messageCount === this.messages.length, "rpc_idle");
					requireFact(data.sessionId === this.bootstrap?.sessionId, "rpc_session");
					equal(model, this.bootstrap.model, "rpc_model_identity");
					this.idleFrame = this.frameIndex;
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
				this.turnStart = this.frameIndex;
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
						this.responseStart = this.frameIndex;
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
			this.turns.push({ start: this.turnStart, response: this.responseStart, answer: this.answer, calls: this.batch });
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

function checkStop(value: unknown, origin: number, target: keyof typeof STOP_GRACE_MS, first: number, last: number) {
	const stop = record(value, "process_closure");
	const { triggerAt, detectedAt, reapedAt, observationCompletedAt, drainCompletedAt, termAttemptAt, killAttemptAt } = stop;
	requireFact(finite(triggerAt) && finite(detectedAt) && finite(reapedAt) && finite(observationCompletedAt) &&
		finite(drainCompletedAt) && (termAttemptAt === null || finite(termAttemptAt)) &&
		(killAttemptAt === null || finite(killAttemptAt)) && stop.termError === null && stop.killError === null, "process_closure");
	const cutoff = triggerAt + UNIT1_LIMITS.killGraceMs;
	const scheduledKillAt = triggerAt + STOP_GRACE_MS[target];
	const within = (at: number) => at >= detectedAt && at <= cutoff && at - origin <= last;
	requireFact(triggerAt - origin >= first && triggerAt <= detectedAt &&
		stop.scheduledKillAt === scheduledKillAt && stop.signalDeadline === cutoff && stop.observationDeadline === cutoff &&
		stop.drainDeadline === cutoff && within(reapedAt) && within(observationCompletedAt) &&
		reapedAt <= observationCompletedAt && within(drainCompletedAt), "process_closure");
	const retired = target === "pi" ? "Direct child reaped" : "Owned group absent and direct child reaped";
	requireFact((killAttemptAt === null && stop.noKillReason === retired) ||
		(killAttemptAt !== null && stop.noKillReason === null && killAttemptAt >= scheduledKillAt &&
			within(killAttemptAt) && killAttemptAt <= observationCompletedAt && termAttemptAt !== null &&
			termAttemptAt <= killAttemptAt), "process_closure");
	requireFact(termAttemptAt === null ? target === "pi" : within(termAttemptAt) && termAttemptAt <= observationCompletedAt,
		"process_closure");
	equal(stop.drain, { kind: "drained" }, "process_drain");
	return { trigger: triggerAt - origin, reap: reapedAt - origin, observed: observationCompletedAt - origin,
		drained: drainCompletedAt - origin, cutoff: cutoff - origin,
		term: termAttemptAt === null ? null : termAttemptAt - origin, kill: killAttemptAt === null ? null : killAttemptAt - origin };
}

function attemptPaths(identity: AttemptIdentity) {
	const attempt = `attempts/${identity.attemptId}`;
	return { attempt, capture: `${attempt}/capture`, settings: `${attempt}/agent/settings.json`, index: `_index/${identity.attemptId}.json` };
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
	const { capture, settings, index } = attemptPaths(identity);
	const assets: [string, string, number][] = [
		...baseArtifacts.map(([file, role, cap]): [string, string, number] => [`${capture}/${file}`, role, cap]),
		[settings, "settings", UNIT1_LIMITS.controlFrameBytes],
		[index, "final_index", UNIT1_LIMITS.controlFrameBytes],
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
type JournalEvent = Record<string, unknown> & { kind: string; body: Body; monotonicMs: number; seq: number };

function attemptRecords(bytes: Buffer, anchor: ExpectedCommitments, id: AttemptIdentity): JournalEvent[] {
	const events: JournalEvent[] = [];
	let time = 0;
	for (const { value } of frames(bytes, UNIT1_LIMITS.journalTotalBytes)) {
		const event = record(value, "journal_record");
		requireFact(event.runId === anchor.runId && event.attemptId === id.attemptId &&
			event.seq === events.length + 1 && typeof event.kind === "string" && finite(event.monotonicMs) &&
			event.monotonicMs >= time && typeof event.utcIso === "string" && !Number.isNaN(Date.parse(event.utcIso)), "journal_envelope");
		time = event.monotonicMs;
		events.push({ ...event, kind: event.kind, seq: event.seq, monotonicMs: event.monotonicMs, body: record(event.body, "journal_body") });
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
	origin: number; piStopAt: number;
}): Readonly<{ nativePid: number; pgid: number }> {
	const { events, call, ordinal, artifacts, capture, nativePath, originalRoot, origin, piStopAt } = input;
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
	const stop = checkStop(closure.stop, origin, "native", events[2].monotonicMs, events[5].monotonicMs);
	requireFact(observation.checkedAtMonotonicMs >= Math.max(stop.reap, stop.term ?? 0, stop.kill ?? 0) &&
		observation.checkedAtMonotonicMs <= stop.observed && events[4].monotonicMs <= stop.drained &&
		events[5].monotonicMs <= piStopAt, "native_observation");
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

type PiFacts = ReturnType<PiProjection["finish"]>;
type PiTurn = PiFacts["turns"][number];

function wireCalls(value: unknown, invariant: string) {
	requireFact(Array.isArray(value), invariant);
	return value.map((item: unknown) => {
		const call = record(item, invariant);
		const fn = record(call.function, invariant);
		requireFact(call.type === "function" && typeof fn.arguments === "string", invariant);
		let args: unknown;
		try { args = JSON.parse(fn.arguments); }
		catch { throw new Error(invariant); }
		return { id: call.id, name: fn.name, args };
	});
}

function callDeclarations(turn: PiTurn) {
	return turn.calls.map(({ id, name, args }) => ({ id, name, args }));
}

function checkProviderHistory(value: unknown, previous: readonly PiTurn[]): void {
	requireFact(Array.isArray(value), "provider_messages");
	const messages = value.slice(2);
	let i = 0;
	for (const turn of previous) {
		const assistant = record(messages[i++], "provider_tool_history");
		requireFact(assistant.role === "assistant" && assistant.content === null, "provider_tool_history");
		equal(wireCalls(assistant.tool_calls, "provider_tool_history"), callDeclarations(turn), "provider_tool_history");
		for (const call of turn.calls) {
			const tool = record(messages[i++], "provider_tool_history");
			requireFact(tool.role === "tool" && tool.tool_call_id === call.id, "provider_tool_history");
			requireFact(call.result && extractUserContentText(tool.content) === call.result.text, "provider_tool_result");
		}
	}
	requireFact(i === messages.length, "provider_tool_history");
}

function checkProviderOutcome(value: unknown, turn: PiTurn) {
	const outcome = record(value, "provider_outcome");
	const { kind } = outcome;
	const { answer, calls } = turn;
	switch (kind) {
		case "tool_calls":
			requireFact(answer.stop === "toolUse" && answer.text === "" && answer.error === null && calls.length > 0, "provider_outcome");
			equal(wireCalls(outcome.calls, "provider_outcome"), callDeclarations(turn), "provider_outcome");
			break;
		case "text": {
			const finish = outcome.finishReason;
			requireFact(finish === "stop" || finish === "length" || finish === "content_filter", "provider_outcome");
			equal(answer, finish === "content_filter"
				? { text: outcome.text, stop: "error", error: "Provider finish_reason: content_filter" }
				: { text: outcome.text, stop: finish, error: null }, "provider_outcome");
			break;
		}
		case "transport_reset":
			requireFact(answer.stop === "error" && answer.text === "" && typeof answer.error === "string" &&
				answer.error.startsWith("Connection error.") && answer.error.endsWith("(UND_ERR_SOCKET)"), "provider_outcome");
			break;
		case "http_error": {
			requireFact(unsigned(outcome.status) && outcome.status >= 400 && outcome.status <= 599 && typeof outcome.body === "string" &&
				answer.stop === "error" && answer.text === "" && typeof answer.error === "string", "provider_outcome");
			const body = record(JSON.parse(outcome.body), "provider_outcome");
			const error = record(body.error, "provider_outcome");
			requireFact(typeof error.message === "string" && error.message.length > 0 &&
				(answer.error.startsWith(`${outcome.status} `) || answer.error.startsWith(`${outcome.status}: `)) &&
				answer.error.includes(error.message), "provider_outcome");
			break;
		}
		default: throw new Error("provider_outcome");
	}
	return kind;
}

function providerRequests(input: {
	events: JournalEvent[]; rawRefs: JournalEvent[]; prompt: string; cwd: string; seen: unknown; pi: PiFacts;
	preflight: JournalEvent; terminal: JournalEvent; stopAt: number; origin: number; baseUrl: string;
}) {
	const { events, rawRefs, prompt, cwd, seen, pi, preflight, terminal, stopAt, origin, baseUrl } = input;
	requireFact(Array.isArray(seen), "loopback_capture");
	let authorization: { kind: "candidate" | "granted"; candidate: Body } | null = null;
	let used = 0;
	let seq = 1;
	let watermark = 1;
	const outcomes: ReturnType<typeof checkProviderOutcome>[] = [];

	for (const event of events) {
		const { kind, body } = event;
		if (kind === "tool_start_reserved") {
			requireFact(!authorization && unsigned(body.bridgeSeq) && body.bridgeSeq > seq, "bridge_sequence");
			used++;
			seq = watermark = body.bridgeSeq;
			continue;
		}
		if (kind !== "provider_candidate" && kind !== "provider_grant" && kind !== "provider_permit_sent") continue;
		const turn = pi.turns[outcomes.length];
		const start = turn && rawRefs[turn.start];
		const response = turn && rawRefs[turn.response];
		requireFact(start && response && start.seq > preflight.seq && event.seq > start.seq &&
			event.seq < response.seq && event.seq < terminal.seq && event.monotonicMs <= stopAt, "provider_lifecycle");
		switch (kind) {
			case "provider_candidate": {
				const { payloadJson } = body;
				requireFact(!authorization && unsigned(body.seq) && body.seq > seq && body.watermark === watermark &&
					typeof payloadJson === "string" && body.payloadDigest === sha256Buffer(payloadJson) &&
					body.payloadByteLength === Buffer.byteLength(payloadJson), "provider_candidate");
				requireFact(validateProviderPayload({ payloadJson, expectedModelId: PROOF_MODEL.model, expectedEncodedPrompt: prompt, expectedSystemPrompt: systemPrompt(cwd) }).ok, "provider_profile");
				authorization = { kind: "candidate", candidate: body };
				seq = body.seq;
				break;
			}
			case "provider_grant":
				requireFact(authorization?.kind === "candidate" && body.seq === authorization.candidate.seq &&
					body.watermark === authorization.candidate.watermark && body.payloadDigest === authorization.candidate.payloadDigest &&
					body.attemptsUsedSoFar === used && used <= UNIT1_LIMITS.maxAttempts, "provider_grant");
				authorization = { kind: "granted", candidate: authorization.candidate };
				break;
			case "provider_permit_sent": {
				requireFact(authorization?.kind === "granted" && body.seq === authorization.candidate.seq &&
					body.payloadDigest === authorization.candidate.payloadDigest, "provider_permit");
				const wire = record(seen[outcomes.length], "missing_loopback_request");
				requireFact(wire.seq === outcomes.length + 1 && wire.method === "POST" && wire.url === "/v1/chat/completions" &&
					typeof wire.bodyText === "string" && typeof authorization.candidate.payloadJson === "string" &&
					finite(wire.receivedAt), "loopback_capture");
				equal(wire.baseUrl, baseUrl, "loopback_endpoint");
				const receivedAt = wire.receivedAt - origin;
				requireFact(receivedAt >= event.monotonicMs && receivedAt <= response.monotonicMs && receivedAt <= stopAt,
					"provider_lifecycle");
				const payload = record(JSON.parse(authorization.candidate.payloadJson), "provider_candidate");
				equal(JSON.parse(wire.bodyText), payload, "wire_payload");
				checkProviderHistory(payload.messages, pi.turns.slice(0, outcomes.length));
				outcomes.push(checkProviderOutcome(wire.outcome, turn));
				authorization = null;
				break;
			}
		}
	}
	requireFact(!authorization && seen.length === outcomes.length && outcomes.length > 0, "provider_request_coverage");
	requireFact(outcomes.length === pi.turns.length, "provider_turn_coverage");
	return outcomes;
}

function validateAttempt(params: {
	root: string; originalRoot: string; anchor: ExpectedCommitments; plan: PublicRunPlan; closure: Body; adapterPath: string;
	identity: AttemptIdentity; artifacts: unknown; question: PublicRunPlan["cases"][number];
	live?: PiFacts;
}) {
	const { root, originalRoot, anchor, plan, closure, identity, question } = params;
	const { attempt, capture, settings, index } = attemptPaths(identity);
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
	if (params.live) equal(params.live, piClosed, "live_closed_pi");
	const bootstrap = piClosed.bootstrap;
	requireFact(bootstrap, "rpc_bootstrap");

	const ready = one("bound_ready").body;
	equal(ready, {
		seq: 1, activeTools: ["clec"], deferredTools: [],
		model: { provider: PROOF_MODEL.provider, id: PROOF_MODEL.model }, thinkingLevel: PROOF_MODEL.thinking,
	}, "bound_ready");
	equal(one("bound_ready_ack").body, { seq: 1 }, "bound_ready_ack");
	const state = one("get_state_ok");
	equal(state.body, {
		modelProvider: PROOF_MODEL.provider, modelId: PROOF_MODEL.model, thinkingLevel: PROOF_MODEL.thinking, autoCompactionEnabled: false,
		sessionId: bootstrap.sessionId, baseUrl: bootstrap.baseUrl,
	}, "rpc_bootstrap_identity");
	requireFact(rawRefs[bootstrap.frame].seq > one("bound_ready_ack").seq && rawRefs[bootstrap.frame].seq < state.seq, "rpc_bootstrap_order");
	equal(one("prompt_encoded").body, {
		originalQuestionSha256: question.questionSha256, encodedPromptSha256: sha256Buffer(prompt), encodedByteLength: Buffer.byteLength(prompt),
	}, "prompt_encoded");
	const promptCommit = one("prompt_sent");
	equal(promptCommit.body, { id: "prompt-1", message: prompt }, "prompt_sent");
	const preflight = one("prompt_preflight");
	equal(preflight.body, { disposition: "started" }, "prompt_preflight");
	const promptResponse = piClosed.promptFrame === null ? null : rawRefs[piClosed.promptFrame];
	requireFact(promptResponse && promptCommit.seq < promptResponse.seq && promptResponse.seq < preflight.seq, "rpc_prompt_order");
	if (!denial) equal(one("agent_settled").body, { aborted: false }, "agent_settled");
	const lifecycle = ["plan_committed", "closure_verified", "pi_spawned", "bound_ready", "bound_ready_ack", "get_state_ok",
		"prompt_encoded", "prompt_sent", "prompt_preflight", ...(denial ? ["tool_start_denied"] : ["agent_settled"]),
		"pi_exited", "attempt_closed"];
	const lifecycleSet = new Set(lifecycle);
	equal(events.filter(event => lifecycleSet.has(event.kind)).map(event => event.kind), lifecycle, "journal_lifecycle");
	const supported = new Set([...lifecycle, ...groupKinds, "pi_frame", "provider_candidate", "provider_grant",
		"provider_permit_sent", "tool_declared_batch", "tool_start_reserved"]);
	requireFact(events.every(event => supported.has(event.kind)), "journal_invalid_evidence");
	const launch = one("pi_spawned");
	const spawned = launch.body;
	requireFact(unsigned(spawned.pid) && spawned.pid > 0 && typeof spawned.lstart === "string" && spawned.adapterPath === params.adapterPath, "pi_pid");
	const origin = spawned.monotonicStartMs;
	const baseUrl = spawned.baseUrl;
	requireFact(finite(origin), "attempt_clock");
	requireFact(typeof baseUrl === "string" && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1$/.test(baseUrl) &&
		baseUrl === bootstrap.baseUrl, "loopback_endpoint");
	const exitEvent = one("pi_exited");
	const exited = exitEvent.body;
	const piStop = record(exited.stop, "pi_exit");
	const terminal = denials[0] ?? one("agent_settled");
	requireFact(finite(piStop.triggerAt), "process_closure");
	const outcomes = providerRequests({ events, rawRefs, prompt, cwd, seen: parseRawJson(wire), pi: piClosed,
		preflight, terminal, stopAt: piStop.triggerAt - origin, origin, baseUrl });
	requireFact(denial
		? exited.code === null && (exited.signal === "SIGKILL" ? finite(piStop.killAttemptAt)
			: exited.signal === "SIGTERM" && finite(piStop.termAttemptAt))
		: exited.code === 0 && exited.signal === null, "pi_exit");
	const idle = piClosed.idleFrame === null ? null : rawRefs[piClosed.idleFrame];
	const stopped = checkStop(piStop, origin, "pi", (idle ?? preflight).monotonicMs, exitEvent.monotonicMs);
	const exitObserved = exited.observedAtMonotonicMs;
	const lastFrame = rawRefs.at(-1);
	requireFact(finite(exitObserved) && exitObserved <= stopped.reap && stopped.reap === stopped.observed &&
		lastFrame && lastFrame.seq < exitEvent.seq, "pi_exit_chronology");
	if (denial) {
		const signalAt = exited.signal === "SIGKILL" ? stopped.kill : stopped.term;
		requireFact(signalAt !== null && signalAt <= exitObserved && stopped.trigger <= terminal.monotonicMs &&
			terminal.monotonicMs <= exitObserved, "pi_exit_chronology");
	} else {
		requireFact(idle && terminal.seq < idle.seq && idle.monotonicMs <= exitObserved && exitObserved <= stopped.trigger &&
			stopped.term === null && stopped.kill === null, "pi_exit_chronology");
	}

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
		if (event.kind === "group_closure_observed") requireFact(event.seq > exitEvent.seq, "native_closure_order");
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
			nativePath: String(nativePath), originalRoot, origin, piStopAt: stopped.trigger,
		}) : null;
		if (executable) requireFact(Number(group?.[0]?.seq) > Number(reservation.seq), "native_reservation_order");
		else requireFact(!group && call.result?.isError === true, "invalid_tool_rejection");
		return { id: call.id, name: call.name, ordinal, result: call.result, native };
	});
	requireFact(groups.size === 0, "unpaired_native");

	const answer = piClosed.answer;
	const transport = outcomes.length === 1 && outcomes[0] === "transport_reset";
	const eligible = transport && !piClosed.workObserved && calls.length === 0;
	const status = denial ? "DeniedAndTerminated" : answer.stop === "stop" && answer.text.trim().length > 0 ? "Answered"
		: eligible ? "PreWorkInfrastructureFailed" : "TaskFailed";
	const rawClosed = one("attempt_closed");
	requireFact(rawClosed === events.at(-1) && rawClosed.body.uncertified === false, "attempt_terminal");
	equal(rawClosed.body.status, status === "PreWorkInfrastructureFailed" ? "TaskFailed" : status, "attempt_status");
	equal(rawClosed.body.nativeStarts, callSummary.filter(call => call.native).length, "native_count");
	equal(rawClosed.body.providerRequestsGranted, outcomes.length, "provider_count");
	equal(rawClosed.body.providerRequestsDenied, 0, "provider_denied_count");
	const owner = record(parseRawJson(artifacts.take(index, "final_index", UNIT1_LIMITS.controlFrameBytes)), "final_owner");
	requireFact(owner.runId === anchor.runId && owner.attemptId === identity.attemptId &&
		owner.indexEntryPath === join(originalRoot, index) && owner.piPid === spawned.pid &&
		owner.closureBeforeSha256 === closure.closureDigest, "final_owner_identity");
	requireFact(owner.uncertified === false && owner.indexPublicationError === undefined, "final_owner_drain");
	equal(owner.captureDrain, { kind: "drained" }, "final_owner_drain");
	const finalCapture = record(owner.finalCapture, "final_owner_drain");
	requireFact(finite(finalCapture.closedAtMonotonicMs) && finalCapture.closedAtMonotonicMs >= rawClosed.monotonicMs &&
		finalCapture.closedAtMonotonicMs <= stopped.cutoff && finalCapture.journalSeq === rawClosed.seq &&
		finalCapture.journalBytes === journal.length, "final_owner_drain");
	equal(owner.rawArtifacts, {
		journalPath: join(originalRoot, capture, "journal.jsonl"),
		piStdoutPath: join(originalRoot, capture, "pi.stdout.jsonl"),
		piStderrPath: join(originalRoot, capture, "pi.stderr.bin"),
	}, "final_owner_identity");
	equal(owner.piStop, piStop, "final_owner_process");
	equal(owner.piExitCode, exited.code, "final_owner_process");
	equal(owner.piSignal, exited.signal, "final_owner_process");
	requireFact(Array.isArray(owner.groupObservations), "final_owner_process");
	const closedGroups = byKind("group_closure_observed");
	requireFact(owner.groupObservations.length === closedGroups.length, "final_owner_process");
	for (const [i, value] of owner.groupObservations.entries()) {
		const group = record(value, "final_owner_process");
		const closure = closedGroups[i].body;
		const native = callSummary.find(call => `lease-${call.ordinal}` === closure.leaseId)?.native;
		requireFact(native && group.state === "Closed" && group.registeredBeforeGo === true &&
			group.pgid === native.pgid && group.helperPid === native.pgid && group.nativePid === native.nativePid,
			"final_owner_process");
		equal({ leaseId: group.leaseId, observation: group.closure, stop: group.stop }, closure, "final_owner_process");
	}
	requireFact(owner.status === rawClosed.body.status && owner.failureReason === rawClosed.body.failureReason &&
		owner.nativeStarts === rawClosed.body.nativeStarts && owner.providerRequestsGranted === outcomes.length &&
		owner.providerRequestsDenied === 0 && owner.promptReceived === true &&
		owner.originalQuestionBytesSha256 === question.questionSha256 && owner.encodedPromptText === prompt &&
		owner.encodedPromptBytesSha256 === sha256Buffer(prompt) &&
		owner.answerText === (piClosed.turns.findLast(turn => turn.answer.text !== "")?.answer.text ?? null),
		"final_owner_outcome");
	artifacts.finish();
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

type LiveAttempt = Readonly<{ identity: AttemptIdentity; projection: PiFacts }>;

function validateRun(root: string, expected: ExpectedCommitments, mode: Mode, live?: LiveAttempt): Validation {
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
	let active = false;
	for (const frame of entries) {
		const entry = record(frame.value, "run_record");
		requireFact(!terminal && entry.seq === ++seq && entry.plan === expected.plan && entry.runId === expected.runId, "run_lifecycle");
		if (entry.kind === "run_closed") {
			requireFact(next === null && caseIndex === plan.cases.length, attempts.length ? "scheduled_case_missing" : "empty_attempts");
			requireFact(!active, "attempt_incomplete");
			equal(entry.witness, witness, "closure_postcheck");
			terminal = true;
			continue;
		}
		if (entry.kind === "attempt_started") {
			requireFact(!active && next, "attempt_start");
			equal(entry.identity, next, "attempt_start");
			active = true;
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
		requireFact(active, "attempt_start");
		equal(entry.witness, witness, "closure_postcheck");
		equal(entry.corpusAfter, STATUS_CORPUS, "corpus_postcheck");
		const result = validateAttempt({
			root, originalRoot: expected.originalRoot, anchor: expected, plan,
			identity: next, question: plan.cases[caseIndex], closure, adapterPath: adapter.logicalPath,
			artifacts: entry.artifacts, live: live?.identity.attemptId === next.attemptId ? live.projection : undefined,
		});
		active = false;
		attempts.push(result);
		if (next.ordinal === 2) replacements++;
		if (next.ordinal === 1 && replacements === 0 && result.status === "PreWorkInfrastructureFailed") {
			next = replacement(expected.runId, next);
		} else {
			const upcoming = plan.cases[++caseIndex];
			next = upcoming ? initialAttempt(expected.runId, upcoming.id) : null;
		}
	}
	if (active) return { kind: "Incomplete", attempts, next: null, invariant: "attempt_incomplete" };
	if (mode === "Prefix") return { kind: "Incomplete", attempts, next, invariant: next ? "schedule_pending" : "seal_pending" };
	if (!terminal) return { kind: "Incomplete", attempts, next, invariant: attempts.length === 0 ? "empty_attempts" : next ? "scheduled_case_missing" : "run_not_closed" };
	const summary: RunSummary = {
		version: 1, runId: expected.runId, plan: expected.plan, profile: expected.profile, attemptCount: attempts.length,
		replacementsUsed: replacements, status: plan.cases.every(c => attempts.findLast(a => a.identity.caseId === c.id)?.status === "Answered")
			? "Answered" : "TaskFailed", attempts,
	};
	return { kind: "Complete", summary };
}

export function reconcile(root: string, expected: ExpectedCommitments, mode: Mode, live?: LiveAttempt): Validation {
	try { return validateRun(root, expected, mode, live); }
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
