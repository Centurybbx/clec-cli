import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { artifactRef, frames } from "./artifacts.ts";
import { digest, publicProfile } from "./contract.ts";
import { writeExclusiveFile } from "./framing.ts";
import { captureExecutionClosure, sha256Buffer } from "./pins.ts";
import { collectRun, inspectRun, sealRun } from "./runner.ts";
import { PiProjection } from "./validate.ts";

const parent = process.argv[2];
assert(parent, "Pass an existing private output directory");
const output = mkdtempSync(join(parent, "unit2-controls-"));
process.stdout.write(`evidence ${output}\n`);
const closure = captureExecutionClosure();
const profile = publicProfile(closure);
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
	const run = await collectRun({ version: 1, profile, cases: cases(...ids) }, output, fixture);
	assert.equal(run.result.kind, "Complete", JSON.stringify(run.result));
	const summary = run.result.summary;
	assert.equal(summary.status, expectedStatus);
	assert.equal(summary.replacementsUsed, replacements);
	assert.deepEqual(summary.attempts.map(a => a.status), statuses);
	assert.deepEqual(run.progression.map(p => p.attempts.length), [0, ...summary.attempts.map((_, i) => i + 1)]);
	assert.deepEqual(run.progression.at(-1).attempts, summary.attempts);
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
	for (const file of ["plan.json", "run.jsonl", "summary.json"]) {
		cpSync(join(baseline.root, file), join(root, file), { force: false, errorOnExist: true });
	}
	const runFile = join(root, "run.jsonl");
	const run = readLines(runFile);
	for (const item of run.filter(entry => entry.kind === "attempt")) {
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
		set("journal", lines(entries.map((event, i) => ({ ...event, seq: i + 1 }))));
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
	change({ root, run, attempt, expected, refFor, set, journal, raw });
	writeFileSync(runFile, lines(run.map((entry, i) => ({ ...entry, seq: i + 1 }))));
	const sealed = await sealRun(root, expected);
	const inspected = inspectRun(root, expected);
	assert.deepEqual(sealed, inspected);
	assert.equal(sealed.invariant, expectedInvariant, `${name}: ${JSON.stringify(sealed)}`);
	mutations.push({ name, root, sealed, inspected });
	process.stdout.write(`pass mutation ${name} ${expectedInvariant}\n`);
}

await mutate("empty", "empty_attempts", ({ run }) => run.splice(1, 1));
await mutate("duplicate_attempt", "duplicate_attempt", ({ run, attempt }) => run.splice(2, 0, structuredClone(attempt)));
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
	for (const entry of run) entry.witness.inventory.nativePin.sha256 = "f".repeat(64);
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
	run[2].identity.predecessor = "foreign-case-a1";
}, "replacement");
await mutate("omitted_case", "scheduled_case_missing", ({ run }) => run.splice(2, 1), "two");
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
	run.splice(2, 0, replacement);
}, "refusal");
await mutate("second_global_reattempt", "unexpected_reattempt", ({ run }) => {
	const replacement = structuredClone(run[3]);
	replacement.identity.attemptId += "-unexpected";
	replacement.identity.ordinal = 2;
	replacement.identity.predecessor = run[3].identity.attemptId;
	run.splice(4, 0, replacement);
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
const rows = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" }).trim().split("\n");
const survivors = rows.filter(row => {
	const [pid, pgid] = row.trim().split(/\s+/, 3).map(Number);
	return pids.has(pid) || pgids.has(pgid);
});
assert.deepEqual(survivors, []);
writeExclusiveFile(join(output, "receipt.json"), JSON.stringify({
	runs: Array.from(runs, ([name, run]) => ({ name, root: run.root, anchorPath: run.anchorPath,
		manifestSha256: sha256Buffer(readFileSync(join(run.root, "summary.json"))) })),
	mutations, profile, closure, pids: [...pids], pgids: [...pgids], survivors,
}, null, 2));
process.stdout.write(`pass ${runs.size} real runs, ${mutations.length} isolated mutations, ${pids.size} PIDs and ${pgids.size} PGIDs clear\n`);
