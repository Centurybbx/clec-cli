import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import {
	cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { artifactRef, frames } from "../validate/artifacts.ts";
import { buildPublicFixture, fixtureProfile } from "./corpus.ts";
import { digest } from "../contract.ts";
import { BoundedJournalWriter, writeExclusiveFile } from "../capture/framing.ts";
import { captureExecutionClosure, sha256Buffer } from "../capture/pins.ts";
import { collectRun, inspectRun, sealRun } from "../runner.ts";
import { PiProjection } from "../validate.ts";

const parent = process.argv[2];
assert(parent, "Pass an existing private output directory");
const output = mkdtempSync(join(parent, "unit2-controls-"));
process.stdout.write(`evidence ${output}\n`);
const closure = captureExecutionClosure();
const { dir: corpusDir } = buildPublicFixture(output);
const profile = fixtureProfile(corpusDir, closure);
const cases = (...ids) => ids.map(id => {
	const question = `/Synthetic ${id}\nStatus fixture — café @example`;
	return { id, question, questionSha256: sha256Buffer(question) };
});

const native = seq => ({
	kind: "tool_calls", calls: [{ id: `status_call_${seq}`, name: "clec", rawArgumentsJson: '{"action":"status"}' }],
});
const answer = { kind: "text", text: "Synthetic status recorded." };
const reset = { kind: "transport_reset" };
const ordinary = (_, seq) => seq === 1 ? native(seq) : answer;
const runs = new Map();

async function baseline(name, ids, fixture, expectedStatus, replacements, statuses) {
	const run = await collectRun({ version: 1, profile, cases: cases(...ids) }, output, corpusDir, fixture);
	assert.equal(run.result.kind, "Complete", JSON.stringify(run.result));
	const summary = run.result.summary;
	assert.equal(summary.status, expectedStatus);
	assert.equal(summary.replacementsUsed, replacements);
	assert.deepEqual(summary.attempts.map(a => a.status), statuses);
	assert.deepEqual(run.progression.map(p => p.attempts.length), [0, ...summary.attempts.map((_, i) => i + 1)]);
	assert.deepEqual(run.progression.at(-1).attempts, summary.attempts);
	assert.deepEqual(await sealRun(run.root, run.expected), run.result);
	assert.deepEqual(inspectRun(run.root, readJson(run.anchorPath)), run.result);
	const runEntries = readLines(join(run.root, "run.jsonl"));
	const prefixFacts = [];
	for (const entry of runEntries.filter(entry => entry.kind === "attempt")) {
		const file = entry.artifacts.find(art => art.role === "pi_stdout").path;
		const prompt = profile.limits.promptPrefix + cases(entry.identity.caseId)[0].question;
		const projection = new PiProjection(prompt);
		const steps = [projection.finish("Prefix")];
		for (const frame of frames(readFileSync(join(run.root, file)))) {
			projection.accept(frame.value);
			const fact = projection.finish("Prefix");
			if (fact.stage !== steps.at(-1).stage || fact.workObserved !== steps.at(-1).workObserved ||
				fact.calls !== steps.at(-1).calls) steps.push(fact);
		}
		const projected = projection.finish("Prefix");
		if (summary.attempts.find(a => a.identity.attemptId === entry.identity.attemptId).status === "DeniedAndTerminated") {
			assert.equal(projected.stage, "turn");
			assert.equal(projected.calls, 10);
		} else assert.equal(projection.finish("Closed").stage, "idle");
		prefixFacts.push(steps);
	}
	runs.set(name, run);
	writeExclusiveFile(join(output, `${name}.json`), JSON.stringify({ ...run, prefixFacts }, null, 2));
	process.stdout.write(`pass ${name}\n`);
}

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function readLines(path) { return readFileSync(path, "utf8").trim().split("\n").map(JSON.parse); }
function lines(records) { return Buffer.from(records.map(item => JSON.stringify(item) + "\n").join("")); }
function recordedAttempts(run) { return run.filter(entry => entry.kind === "attempt"); }

function omitAttempt(run, ordinal) {
	const { identity } = recordedAttempts(run)[ordinal];
	const kept = run.filter(entry => entry.identity?.attemptId !== identity.attemptId);
	run.splice(0, run.length, ...kept);
}

await baseline("one", ["alpha"], (_, seq) => seq < 3 ? native(seq) : answer, "Answered", 0, ["Answered"]);
await baseline("two", ["alpha", "beta"], ordinary, "Answered", 0, ["Answered", "Answered"]);
await baseline("replacement", ["alpha"], (attempt, seq) => attempt.ordinal === 1 ? reset : ordinary(attempt, seq),
	"Answered", 1, ["PreWorkInfrastructureFailed", "Answered"]);
await baseline("refusal", ["alpha"], () => ({ kind: "text", text: "I decline.", finishReason: "content_filter" }),
	"TaskFailed", 0, ["TaskFailed"]);
await baseline("post_work", ["alpha"], (_, seq) => seq === 1 ? native(seq)
	: { kind: "text", text: "Partial synthetic answer.", finishReason: "length" }, "TaskFailed", 0, ["TaskFailed"]);
await baseline("global_limit", ["alpha", "beta"], (attempt, seq) => attempt.ordinal === 1 ? reset : ordinary(attempt, seq),
	"TaskFailed", 1, ["PreWorkInfrastructureFailed", "Answered", "PreWorkInfrastructureFailed"]);

await baseline("post_work_reset", ["alpha"], (_, seq) => seq === 1 ? native(seq) : reset, "TaskFailed", 0, ["TaskFailed"]);
await baseline("budget_denial", ["alpha"], () => ({
	kind: "tool_calls", calls: Array.from({ length: 10 }, (_, i) => ({
		id: `budget_${i + 1}`, name: "clec", rawArgumentsJson: JSON.stringify({ action: i < 8 ? "bogus" : "status" }),
	})),
}), "TaskFailed", 0, ["DeniedAndTerminated"]);

const mutations = [];
async function mutate(name, expectedInvariant, change, baselineName = "one") {
	const baseline = runs.get(baselineName);
	const root = mkdtempSync(join(output, `mutation-${name}-`));
	// Copy only the small retained evidence, never the installed/source closure.
	for (const file of ["plan.json", "run.jsonl", "summary.json", "skill.bin"]) {
		cpSync(join(baseline.root, file), join(root, file), { force: false, errorOnExist: true });
	}
	cpSync(join(baseline.root, "corpus"), join(root, "corpus"), { recursive: true, force: false, errorOnExist: true });
	const runFile = join(root, "run.jsonl");
	const run = readLines(runFile);
	for (const item of run.filter(entry => entry.kind === "attempt")) {
		const data = `attempts/${item.identity.attemptId}/data`;
		mkdirSync(join(root, data, ".."), { recursive: true });
		cpSync(join(baseline.root, data), join(root, data), { recursive: true, force: false, errorOnExist: true });
		for (const { path } of item.artifacts) {
			mkdirSync(join(root, path, ".."), { recursive: true });
			cpSync(join(baseline.root, path), join(root, path), { force: false, errorOnExist: true });
		}
	}
	const attempt = run.find(entry => entry.kind === "attempt");
	const refFor = role => attempt.artifacts.find(art => art.role === role);
	function set(role, content) {
		const ref = refFor(role);
		writeFileSync(join(root, ref.path), content);
		Object.assign(ref, artifactRef(ref.path, ref.role, content));
	}
	function journal(transform) {
		const entries = transform(readLines(join(root, refFor("journal").path)));
		const bytes = lines(entries.map((event, i) => ({ ...event, seq: i + 1 })));
		set("journal", bytes);
		const owner = readJson(join(root, refFor("final_index").path));
		Object.assign(owner.finalCapture, { journalSeq: entries.length, journalBytes: bytes.length });
		set("final_index", Buffer.from(JSON.stringify(owner)));
	}
	function raw(transform) {
		const rawRecords = readFileSync(join(root, refFor("pi_stdout").path), "utf8").trimEnd().split("\n");
		const bytes = transform(rawRecords);
		set("pi_stdout", bytes);
		let offset = 0;
		const refs = [];
		for (let start = 0; start < bytes.length;) {
			const end = bytes.indexOf(10, start);
			assert(end >= start);
			const sha256 = sha256Buffer(bytes.subarray(start, end));
			refs.push({ offset, length: end - start + 1, sha256 });
			offset += end - start + 1;
			start = end + 1;
		}
		journal(events => {
			let index = 0;
			return events.flatMap(event => {
				if (event.kind !== "pi_frame") return [event];
				const body = refs[index++];
				return body ? [{ ...event, body }] : [];
			});
		});
	}
	const expected = structuredClone(readJson(baseline.anchorPath));
	change({ root, run, attempt, expected, refFor, set, journal, raw,
		read: role => readJson(join(root, refFor(role).path)) });
	writeFileSync(runFile, lines(run.map((entry, i) => ({ ...entry, seq: i + 1 }))));
	const sealed = await sealRun(root, expected);
	const inspected = inspectRun(root, expected);
	assert.deepEqual(sealed, inspected);
	if (expectedInvariant === null) assert.deepEqual(sealed, baseline.result);
	else assert.equal(sealed.invariant, expectedInvariant, `${name}: ${JSON.stringify(sealed)}`);
	mutations.push({ name, root, sealed, inspected });
	process.stdout.write(`pass mutation ${name} ${expectedInvariant ?? sealed.kind}\n`);
}

await mutate("empty", "empty_attempts", ({ run }) => omitAttempt(run, 0));
await mutate("duplicate_attempt", "duplicate_attempt", ({ run, attempt }) => run.splice(-1, 0, structuredClone(attempt)));
await mutate("running", "attempt_status", ({ journal }) => journal(events => events.map(event =>
	event.kind === "attempt_closed" ? { ...event, body: { ...event.body, status: "Running" } } : event)));
await mutate("missing_answer", "missing_answer", ({ raw }) => raw(frames => {
	const events = frames.map(JSON.parse);
	const end = events.findLastIndex(e => e.type === "message_end" && e.message.role === "assistant");
	const start = events.findLastIndex((e, i) => i < end && e.type === "message_start" && e.message.role === "assistant");
	events.splice(start, end - start + 1);
	return lines(events);
}));
await mutate("illegal_ordinal", "attempt_ordinal", ({ attempt }) => { attempt.identity.ordinal = 3; });
await mutate("missing_native_refs", "missing_artifact", ({ attempt }) => {
	attempt.artifacts = attempt.artifacts.filter(ref => !ref.role.startsWith("native_"));
});
await mutate("count_and_pins", "derived_summary", ({ root }) => {
	const path = join(root, "summary.json");
	const { summary } = readJson(path);
	summary.attemptCount = 24;
	summary.replacementsUsed = 123;
	summary.profile = "f".repeat(64);
	writeFileSync(path, JSON.stringify({ summary, sha256: digest(summary) }));
});
await mutate("runtime_pin", "runtime_witness", ({ run }) => {
	for (const entry of run.filter(e => e.witness)) entry.witness.inventory.nativePin.sha256 = "f".repeat(64);
});
await mutate("agent_end_only", "agent_end_order", ({ raw }) => raw(() => lines([{ type: "agent_end" }])));
await mutate("lost_tool_results", "missing_tool_result", ({ raw }) => raw(records => lines(records.map(JSON.parse)
	.filter(event => event.message?.role !== "toolResult"))));
await mutate("malformed_json", "raw_json", ({ raw }) => raw(records =>
	Buffer.from(["{broken", ...records.slice(1)].join("\n") + "\n")));
await mutate("malformed_utf8", "raw_utf8", ({ raw }) => raw(records => Buffer.concat([
	Buffer.from([0xff, 0x0a]), Buffer.from(records.slice(1).join("\n") + "\n"),
])));
await mutate("unavailable_stream", "missing_artifact", ({ root, refFor }) => rmSync(join(root, refFor("pi_stderr").path)));
await mutate("unpaired_call", "unpaired_call", ({ raw }) => raw(records => lines(records.map(JSON.parse).map(event =>
	event.type === "tool_execution_start" ? { ...event, toolCallId: "foreign-id" } : event))));
await mutate("foreign_predecessor", "replacement_predecessor", ({ run }) => {
	recordedAttempts(run)[1].identity.predecessor = "foreign-case-a1";
}, "replacement");
await mutate("omitted_case", "scheduled_case_missing", ({ run }) => omitAttempt(run, 1), "two");
await mutate("duplicate_call", "duplicate_call", ({ raw }) => raw(records =>
	Buffer.from(records.join("\n").replaceAll("status_call_2", "status_call_1") + "\n")));
await mutate("missing_exit", "native_lifecycle", ({ journal }) => journal(events => events.filter(event =>
	event.kind !== "native_exited" || event.body.leaseId !== "lease-1")));
await mutate("missing_chunk", "native_chunk_coverage", ({ set }) => set("native_chunks", Buffer.alloc(0)));
await mutate("unexpected_reattempt", "unexpected_reattempt", ({ run, attempt }) => {
	const replacement = structuredClone(attempt);
	replacement.identity.attemptId += "-unexpected";
	replacement.identity.ordinal = 2;
	replacement.identity.predecessor = attempt.identity.attemptId;
	run.splice(-1, 0, replacement);
}, "refusal");
await mutate("second_global_reattempt", "unexpected_reattempt", ({ run }) => {
	const replacement = structuredClone(recordedAttempts(run)[2]);
	replacement.identity.attemptId += "-unexpected";
	replacement.identity.ordinal = 2;
	replacement.identity.predecessor = recordedAttempts(run)[2].identity.attemptId;
	run.splice(-1, 0, replacement);
}, "global_limit");
await mutate("changed_anchor", "external_anchor", ({ expected }) => { expected.plan = "c".repeat(64); });
await mutate("changed_plan", "external_anchor", ({ root }) => {
	const path = join(root, "plan.json");
	writeFileSync(path, readFileSync(path, "utf8") + "\n");
});
await mutate("stream_range", "artifact_ref", ({ refFor }) => { refFor("pi_stderr").offset = 1; });
await mutate("pi_frame_range", "pi_frame_range", ({ journal }) => journal(events => events.map(event =>
	event.kind === "pi_frame" && event.body.offset === 0 ? { ...event, body: { ...event.body, offset: 1 } } : event)));
await mutate("symlink_escape", "artifact_path", ({ root, refFor }) => {
	const path = refFor("pi_stderr").path;
	rmSync(join(root, path));
	symlinkSync(join(runs.get("one").root, path), join(root, path));
});
await mutate("native_count", "native_count", ({ journal }) => journal(events => events.map(event =>
	event.kind === "attempt_closed" ? { ...event, body: { ...event.body, nativeStarts: 0 } } : event)));

const originalMutations = mutations.length;
assert.equal(originalMutations, 27);

function donorArtifact(name, ordinal, role) {
	const { root } = runs.get(name);
	const attempt = recordedAttempts(readLines(join(root, "run.jsonl")))[ordinal];
	return readFileSync(join(root, attempt.artifacts.find(art => art.role === role).path));
}

function moveAuthorization(events, landmark, after) {
	const kinds = new Set(["provider_candidate", "provider_grant", "provider_permit_sent"]);
	const moved = events.filter(event => kinds.has(event.kind));
	const ordered = events.filter(event => !kinds.has(event.kind));
	ordered.splice(ordered.findIndex(event => event.kind === landmark) + Number(after), 0, ...moved);
	return ordered.map(({ kind, body }, i) => ({ ...events[i], kind, body }));
}

await mutate("grant_after_exit", "provider_lifecycle", ({ journal }) =>
	journal(events => moveAuthorization(events, "pi_exited", true)), "replacement");
await mutate("grant_before_prompt", "provider_lifecycle", ({ journal }) =>
	journal(events => moveAuthorization(events, "prompt_sent", false)), "replacement");
await mutate("missing_grant", "provider_permit", ({ journal }) =>
	journal(events => events.filter(e => e.kind !== "provider_grant")), "replacement");
await mutate("foreign_chunks", "native_chunk", ({ set }) => set("native_chunks", donorArtifact("two", 0, "native_chunks")));
await mutate("changed_profile_anchor", "external_anchor", ({ expected }) => { expected.profile = "1".repeat(64); });

function mutateProviderHistory(change, mutatePayload, requestIndex = -1) {
	const { set, read, journal } = change;
	const loopback = read("loopback");
	const request = loopback.at(requestIndex);
	const wire = JSON.parse(request.bodyText);
	mutatePayload(wire.messages);
	request.bodyText = JSON.stringify(wire);
	set("loopback", Buffer.from(JSON.stringify(loopback)));
	journal(events => {
		const candidate = events.filter(e => e.kind === "provider_candidate").at(requestIndex).body;
		const payload = JSON.parse(candidate.payloadJson);
		mutatePayload(payload.messages);
		const oldDigest = candidate.payloadDigest;
		candidate.payloadJson = JSON.stringify(payload);
		candidate.payloadByteLength = Buffer.byteLength(candidate.payloadJson);
		const digest = sha256Buffer(candidate.payloadJson);
		for (const { body } of events) if (body.payloadDigest === oldDigest) body.payloadDigest = digest;
		return events;
	});
}
await mutate("foreign_provider_call", "provider_tool_history", change => mutateProviderHistory(change, messages => {
	messages.find(m => m.role === "assistant").tool_calls[0].id = "different_call";
}, 1));
await mutate("foreign_provider_args", "provider_tool_history", change => mutateProviderHistory(change, messages => {
	messages.find(m => m.role === "assistant").tool_calls[0].function.arguments = '{"action":"other"}';
}));
await mutate("reordered_provider_batches", "provider_tool_history", change => mutateProviderHistory(change, messages => {
	const first = messages.splice(2, 2);
	messages.push(...first);
}));

function changeOutcome({ read, set }, change) {
	const loopback = read("loopback");
	loopback.at(-1).outcome = change(loopback.at(-1).outcome);
	set("loopback", Buffer.from(JSON.stringify(loopback)));
}
await mutate("contradictory_outcome", "provider_outcome", change =>
	changeOutcome(change, () => ({ kind: "transport_reset" })));
await mutate("assistant_work_in_reset_turn", "provider_outcome", ({ raw }) => raw(records =>
	lines(records.map(JSON.parse).map(event => {
		if (event.type === "message_start" && event.message?.role === "assistant") {
			event.message.content = [{ type: "thinking", thinking: "Synthetic assistant work." }];
		}
		return event;
	}))), "replacement");
await mutate("refusal_claimed_as_stop", "provider_outcome", change =>
	changeOutcome(change, outcome => ({ ...outcome, finishReason: "stop" })), "refusal");
await mutate("truncation_claimed_as_stop", "provider_outcome", change =>
	changeOutcome(change, outcome => ({ ...outcome, finishReason: "stop" })), "post_work");

function foreignBootstrap({ raw }) {
	const foreign = [...frames(donorArtifact("replacement", 1, "pi_stdout"))][0].value;
	raw(records => {
		const bootstrap = JSON.parse(records[0]);
		assert.notEqual(bootstrap.data.sessionId, foreign.data.sessionId);
		records[0] = JSON.stringify(foreign);
		return Buffer.from(records.join("\n") + "\n");
	});
}
await mutate("foreign_bootstrap", "rpc_session", foreignBootstrap);
await mutate("foreign_terminated_bootstrap", "rpc_bootstrap_identity", foreignBootstrap, "budget_denial");
await mutate("foreign_endpoint", "loopback_endpoint", ({ raw, journal }) => {
	const donor = [...frames(donorArtifact("replacement", 1, "pi_stdout"))][0].value;
	const baseUrl = donor.data.model.baseUrl;
	raw(records => lines(records.map(JSON.parse).map(e => {
		if (e.command === "get_state") e.data.model.baseUrl = baseUrl;
		return e;
	})));
	journal(events => events.map(e => {
		if (e.kind === "pi_spawned" || e.kind === "get_state_ok") e.body.baseUrl = baseUrl;
		return e;
	}));
});

function changeClosure({ journal, set, read }, kind, transform) {
	let body;
	journal(events => {
		body = events.find(event => event.kind === kind).body;
		transform(body);
		return events;
	});
	const owner = read("final_index");
	if (kind === "pi_exited") owner.piStop = body.stop;
	else {
		owner.groupObservations[0].closure = body.observation;
		owner.groupObservations[0].stop = body.stop;
	}
	set("final_index", Buffer.from(JSON.stringify(owner)));
}
await mutate("late_group_observation", "native_observation", change =>
	changeClosure(change, "group_closure_observed", body => { body.observation.checkedAtMonotonicMs = 86_400_000; }));
await mutate("absent_signal_proof", "process_closure", change =>
	changeClosure(change, "pi_exited", ({ stop }) => {
		delete stop.termAttemptAt;
		delete stop.noKillReason;
		stop.drainDeadline = 0;
	}), "replacement");
await mutate("early_drain_cutoff", "process_closure", change =>
	changeClosure(change, "pi_exited", ({ stop }) => { stop.drainDeadline = 0; }));
await mutate("native_signal_error", "process_closure", change =>
	changeClosure(change, "group_closure_observed", ({ stop }) => { stop.termError = "Synthetic signal failure"; }));
await mutate("native_unknown", "native_observation", change =>
	changeClosure(change, "group_closure_observed", body => { body.observation.kind = "unknown"; }));

await mutate("missing_final_owner", "missing_artifact", ({ attempt }) => {
	attempt.artifacts = attempt.artifacts.filter(ref => ref.role !== "final_index");
}, "replacement");
await mutate("foreign_final_owner", "final_owner_identity", ({ set }) =>
	set("final_index", donorArtifact("replacement", 1, "final_index")));
await mutate("incomplete_final_owner", "final_owner_drain", ({ read, set }) => {
	const owner = read("final_index");
	owner.captureDrain = { kind: "incomplete", reason: "Journal drain deadline" };
	delete owner.finalCapture;
	set("final_index", Buffer.from(JSON.stringify(owner)));
});
await mutate("contradictory_final_owner", "final_owner_outcome", ({ read, set }) => {
	const owner = read("final_index");
	owner.status = "Answered";
	set("final_index", Buffer.from(JSON.stringify(owner)));
}, "replacement");
await mutate("uncommitted_journal_tail", "final_owner_drain", ({ read, set }) => {
	const owner = read("final_index");
	owner.finalCapture.journalSeq--;
	set("final_index", Buffer.from(JSON.stringify(owner)));
});

const standardRuns = runs.size;
await baseline("http_error", ["alpha"], () => ({
	kind: "http_error", status: 400, body: JSON.stringify({ error: { message: "Synthetic HTTP failure" } }),
}), "TaskFailed", 0, ["TaskFailed"]);
await mutate("contradictory_http_status", "provider_outcome", change =>
	changeOutcome(change, outcome => ({ ...outcome, status: 403 })), "http_error");

const predecessorMutations = mutations.length;
assert.equal(predecessorMutations, 53);
await baseline("empty_text", ["alpha"], () => ({ kind: "text", text: "" }), "TaskFailed", 0, ["TaskFailed"]);
const quotedMessage = 'Synthetic "field" error';
const escapedMessage = 'Synthetic "field" at C:\\fixture\nSecond line\t✓';
for (const [name, message] of [["quoted_http", quotedMessage], ["escaped_http", escapedMessage]]) {
	await baseline(name, ["alpha"], () => ({
		kind: "http_error", status: 400, body: JSON.stringify({ error: { message } }),
	}), "TaskFailed", 0, ["TaskFailed"]);
	assert.deepEqual(runs.get(name).result.summary.attempts[0].answer,
		{ text: "", stop: "error", error: `400: ${JSON.stringify({ message })}` });
}
await mutate("http_message_substring", "provider_outcome", change =>
	changeOutcome(change, outcome => ({ ...outcome, body: JSON.stringify({ error: { message: "HTTP" } }) })), "http_error");
await mutate("http_escaped_message_changed", "provider_outcome", change =>
	changeOutcome(change, outcome => ({ ...outcome, body: JSON.stringify({ error: { message: escapedMessage.replace("\n", "\\n") } }) })),
	"escaped_http");

function replaceToolDeltas({ raw }, chunks) {
	raw(records => {
		const events = records.map(JSON.parse);
		const end = events.findIndex(event => event.assistantMessageEvent?.type === "toolcall_end");
		const deltas = events.slice(0, end).map(event => event.assistantMessageEvent).filter(update => update?.type === "toolcall_delta");
		assert.equal(deltas.map(update => update.delta).join(""), '{"action":"status"}');
		assert.equal(chunks.length, deltas.length);
		deltas.forEach((update, index) => { update.delta = chunks[index]; });
		return lines(events);
	});
}
await mutate("different_tool_delta_arguments", "assistant_tool_arguments", change =>
	replaceToolDeltas(change, ["", '{"action":"other"}']));
await mutate("different_split_tool_delta_arguments", "assistant_tool_arguments", change =>
	replaceToolDeltas(change, [' { "act', 'ion" : "sta\\u0078us" } ']));
await mutate("equivalent_split_tool_delta_arguments", null, change =>
	replaceToolDeltas(change, [' { "act', 'ion" : "sta\\u0074us" } ']));

function moveAfter(events, select, landmark) {
	const index = events.findIndex(select);
	assert(index >= 0);
	const [moved] = events.splice(index, 1);
	const anchor = events.findIndex(event => event.kind === landmark);
	assert(anchor >= 0);
	events.splice(anchor + 1, 0, { ...moved, monotonicMs: events[anchor].monotonicMs, utcIso: events[anchor].utcIso });
	return events;
}
function moveSecondCandidateAndGrant(events, landmark) {
	const moved = ["provider_candidate", "provider_grant"].map(kind => events.filter(event => event.kind === kind)[1]);
	assert(moved.every(Boolean));
	const kept = events.filter(event => !moved.includes(event));
	const anchor = kept.findIndex(event => event.kind === landmark);
	assert(anchor >= 0);
	kept.splice(anchor + 1, 0, ...moved.map(event =>
		({ ...event, monotonicMs: kept[anchor].monotonicMs, utcIso: kept[anchor].utcIso })));
	return kept;
}
await mutate("authorization_ahead_of_rpc_turn_start", null, ({ journal }) =>
	journal(events => moveSecondCandidateAndGrant(events, "tool_result_delivered")));
await mutate("authorization_before_result_release", "provider_lifecycle", ({ journal }) =>
	journal(events => moveSecondCandidateAndGrant(events, "native_exited")));
for (const [name, landmark] of [["reservation_after_denial", "tool_start_denied"], ["reservation_after_exit", "pi_exited"]]) {
	await mutate(name, "tool_reservation_order", ({ journal }) =>
		journal(events => moveAfter(events, event => event.kind === "tool_start_reserved" && event.body.ordinal === 8, landmark)),
		"budget_denial");
}
await mutate("batch_after_exit", "tool_declarations", ({ journal }) =>
	journal(events => moveAfter(events, event => event.kind === "tool_declared_batch", "pi_exited")), "budget_denial");

function changeOwnerDeclarations({ read, set }, transform) {
	const owner = read("final_index");
	owner.declaredToolCalls = transform(owner.declaredToolCalls);
	set("final_index", Buffer.from(JSON.stringify(owner)));
}
await mutate("omitted_owner_declarations", "final_owner_declarations", change =>
	changeOwnerDeclarations(change, calls => {
		assert.equal(calls.length, 10);
		return [];
	}), "budget_denial");
await mutate("foreign_denied_owner_call", "final_owner_declarations", change =>
	changeOwnerDeclarations(change, calls => calls.map(call => call.ordinal === 9 ? { ...call, id: "foreign_denial" } : call)),
	"budget_denial");
await mutate("released_owner_tail_call", "final_owner_declarations", change =>
	changeOwnerDeclarations(change, calls => calls.map(call => call.ordinal === null ? { ...call, name: "other", ordinal: 10 } : call)),
	"budget_denial");

await mutate("pi_drain_before_frame", "pi_exit_chronology", change =>
	changeClosure(change, "pi_exited", ({ stop }) => { stop.drainCompletedAt = stop.detectedAt; }), "budget_denial");
await mutate("helper_term_after_exit_report", "process_closure", change =>
	changeClosure(change, "group_closure_observed", ({ stop }) => { stop.termAttemptAt = stop.reapedAt + 0.1; }));

const originalClose = BoundedJournalWriter.prototype.close;
let closeInvoked = false;
BoundedJournalWriter.prototype.close = async function (deadline) {
	const file = await this.file;
	const close = file.close.bind(file);
	file.close = async () => {
		closeInvoked = true;
		await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - performance.now() + 150)));
		return close();
	};
	return originalClose.call(this, deadline);
};
let late;
try {
	late = await collectRun({ version: 1, profile, cases: cases("alpha", "beta") }, output, corpusDir, () => reset);
} finally {
	BoundedJournalWriter.prototype.close = originalClose;
}
const indexDir = join(late.root, "_index");
assert.equal(readdirSync(indexDir).length, 1);
const lateIndex = readJson(join(indexDir, readdirSync(indexDir)[0]));
assert(closeInvoked);
assert.equal(lateIndex.uncertified, true);
assert.deepEqual(lateIndex.captureDrain, { kind: "incomplete", reason: "Journal drain deadline" });
assert.equal(lateIndex.finalCapture, undefined);
async function checkIncomplete(run) {
	assert.deepEqual(run.result, { kind: "Incomplete", invariant: "attempt_incomplete", attempts: [], next: null });
	assert.deepEqual(await sealRun(run.root, run.expected), run.result);
	assert.deepEqual(inspectRun(run.root, run.expected), run.result);
	assert(!existsSync(join(run.root, "summary.json")));
	assert(!existsSync(join(output, `${run.expected.runId}.final.json`)));
	assert.deepEqual(readLines(join(run.root, "run.jsonl")).map(entry => entry.kind), ["run_open", "attempt_started"]);
}
await checkIncomplete(late);
writeExclusiveFile(join(output, "late-close-reset.json"), JSON.stringify({ ...late, lateIndex }, null, 2));
process.stdout.write("pass actual journal file-close delay prevents replacement and closure\n");

const link = fsPromises.link;
let refusedIndex = null;
fsPromises.link = async (from, to) => {
	if (String(to).includes("/_index/")) {
		refusedIndex = readJson(from);
		throw new Error("Synthetic attempt index publication refusal");
	}
	return link(from, to);
};
syncBuiltinESMExports();
let refused;
try {
	refused = await collectRun({ version: 1, profile, cases: cases("alpha", "beta") }, output, corpusDir, () => answer);
} finally {
	fsPromises.link = link;
	syncBuiltinESMExports();
}
assert.equal(refusedIndex.status, "Answered");
assert.deepEqual(refusedIndex.captureDrain, { kind: "drained" });
assert.deepEqual(readdirSync(join(refused.root, "_index")), []);
await checkIncomplete(refused);
writeExclusiveFile(join(output, "refused-index.json"), JSON.stringify({ ...refused, refusedIndex }, null, 2));
process.stdout.write("pass refused owner index link prevents progression and closure\n");

const pids = new Set();
const pgids = new Set();
for (const { result } of runs.values()) {
	for (const attempt of result.summary.attempts) {
		pids.add(attempt.piPid);
		for (const call of attempt.calls) if (call.native) {
			pids.add(call.native.nativePid);
			pids.add(call.native.pgid);
			pgids.add(call.native.pgid);
		}
	}
}
pids.add(lateIndex.piPid);
pids.add(refusedIndex.piPid);
const rows = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" }).trim().split("\n");
const survivors = rows.filter(row => {
	const [pid, pgid] = row.trim().split(/\s+/, 3).map(Number);
	return pids.has(pid) || pgids.has(pgid);
});
assert.deepEqual(survivors, []);
writeExclusiveFile(join(output, "receipt.json"), JSON.stringify({
	runs: Array.from(runs, ([name, run]) => ({ name, root: run.root, anchorPath: run.anchorPath,
		manifestSha256: sha256Buffer(readFileSync(join(run.root, "summary.json"))) })),
	standardRuns, originalMutations, predecessorMutations, mutations, profile, closure, pids: [...pids], pgids: [...pgids], survivors,
}, null, 2));
process.stdout.write(`pass ${standardRuns} standard runs, ${runs.size - standardRuns} supplemental runs, ${mutations.length} isolated bundle controls, ${pids.size} PIDs and ${pgids.size} PGIDs clear\n`);
