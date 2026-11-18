import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { buildScrubbedChildEnv, sha256Buffer } from "../capture/pins.ts";
import { BoundedJournalWriter, writeExclusiveFile } from "../capture/framing.ts";
import { collectRun, inspectRun, sealRun } from "../runner.ts";
import { buildPublicFixture, fixtureProfile } from "./corpus.ts";

const root = mkdtempSync(join(process.argv[2], "clec-unit4-contract-"));
console.log(`evidence ${root}`);
const { dir, corpus, publishSha256 } = buildPublicFixture(root);
const profile = fixtureProfile(dir);
const question = "/skill:clec\n{\"type\":\"prompt\"}\n@fixture.txt 測試";
const plan = { version: 1, profile, cases: [{ id: "public", question, questionSha256: sha256Buffer(question) }] };
const [source] = corpus.index.sourceIds;
const [passage] = corpus.index.passageIds;
const [work] = corpus.index.workIds;

const json = path => JSON.parse(readFileSync(path, "utf8"));
const journal = path => readFileSync(path, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));

function calls(args) {
	return { kind: "tool_calls", calls: args.map((request, i) => ({
		id: `public-${i + 1}`, name: request === null ? "bash" : "clec", rawArgumentsJson: JSON.stringify(request ?? {}),
	})) };
}

async function run(name, args, answerExpected = true) {
	const output = join(root, name);
	mkdirSync(output);
	const result = await collectRun(plan, output, dir, (_, sequence) => {
		if (sequence === 1) return calls(args);
		assert.ok(answerExpected, "Denied batch issued another provider request");
		assert.equal(sequence, 2);
		return { kind: "text", text: "Synthetic control complete." };
	});
	assert.equal(result.result.kind, "Complete", JSON.stringify(result.result));
	assert.deepEqual(inspectRun(result.root, result.expected), result.result);
	const attempt = result.result.summary.attempts[0];
	const capture = join(result.root, "attempts", attempt.identity.attemptId, "capture");
	const events = journal(join(capture, "journal.jsonl"));
	const loopback = json(join(capture, "loopback.json"));
	assert.equal(loopback.length, answerExpected ? 2 : 1);
	assert.equal(attempt.status, answerExpected ? "Answered" : "DeniedAndTerminated");
	return { result, attempt, capture, loopback, events };
}

const good = await run("actions", [
	{ action: "schema" }, { action: "help", command: "top" }, { action: "status" },
	{ action: "search", queries: ["分紅", "安全邊際"], matchMode: "any", limit: 5 },
	{ action: "read", ids: [passage], context: 1 },
	{ action: "read", ids: [source], original: true },
	{ action: "sources", canonicalOnly: true, limit: 5, offset: 0 },
	{ action: "status", maxBytes: 1 },
]);
assert.equal(good.attempt.calls.length, 8);
const launches = good.events.filter(event => event.kind === "group_go_sent");
assert.equal(launches.length, 8);
const toolMessages = JSON.parse(good.loopback[1].bodyText).messages.filter(message => message.role === "tool");
for (const [i, { result, native }] of good.attempt.calls.entries()) {
	assert.ok(native);
	const { leaseId, execPath, argv } = launches[i].body;
	assert.equal(execPath, "/private/tmp/clec-coordinator-install.Y1F9gC/prefix 空 格/lib/node_modules/@clec/cli/bin/clec.exe");
	assert.ok(argv.includes("--offline") && argv.includes("--json"));
	assert.equal(toolMessages[i].content, result.text);
	const stdout = readFileSync(join(good.capture, `${leaseId}.native.stdout.bin`));
	if (i > 0 && i < 7) {
		assert.equal(result.isError, false);
		assert.deepEqual(Buffer.from(result.text), stdout);
		assert.match(result.text, /\S/);
	} else {
		assert.equal(result.isError, true);
		assert.match(result.text, /^NATIVE_EXEC_ERROR: CLEC_ERROR:OUTPUT_BUDGET_TOO_SMALL \(exit \d+\)$/);
		const stderr = readFileSync(join(good.capture, `${leaseId}.native.stderr.bin`));
		assert.ok(stderr.length);
		if (i === 0) assert.match(stderr.toString(), /requires 37408 UTF-8 bytes/);
	}
}
assert.ok(good.attempt.calls.some(call => call.result.text.includes("分紅")));
const passageRead = JSON.parse(good.attempt.calls[4].result.text).data.items[0];
assert.equal(passageRead.kind, "passage");
assert.equal(passageRead.passageId, passage);
const originalRead = JSON.parse(good.attempt.calls[5].result.text).data.items[0];
assert.equal(originalRead.kind, "sourceOriginal");
assert.equal(originalRead.source.sourceId, source);
assert.equal(originalRead.source.path, "doc1.txt");
assert.deepEqual(Buffer.from(originalRead.originalText), readFileSync(join(dir, "..", "workspace", "doc1.txt")));
assert.deepEqual(readFileSync(join(good.capture, "question.bin")), Buffer.from(question));
assert.equal(good.attempt.calls[2].result.isError, false);
assert.equal(JSON.parse(good.attempt.calls[2].result.text).data.activeRelease, corpus.commitment.release);

const invalid = [
	{ action: "sync" }, { action: "help", command: "sync" }, { action: "search", queries: ["  --sag2"] },
	{ action: "read", ids: [source] }, { action: "read", original: true, ids: [source, passage] },
	{ action: "search", queries: ["分紅"], workId: `w_${"f".repeat(16)}` },
	{ action: "sources", workId: work, limit: "2" }, null,
];
const denied = await run("rejections", invalid);
assert.equal(denied.events.filter(event => event.kind === "group_reserved").length, 0);
assert.deepEqual(denied.attempt.calls.map(call => call.result.text.split(":")[0]),
	["INVALID_REQUEST", "INVALID_REQUEST", "INVALID_REQUEST", "INVALID_REQUEST", "INVALID_REQUEST",
		"UNKNOWN_CORPUS_ID", "INVALID_REQUEST", "Tool bash not found"]);
const budget = await run("invalid-before-nine", [...invalid, { action: "status" }, { action: "schema" }], false);
assert.equal(budget.events.filter(event => event.kind === "group_reserved").length, 0);
assert.deepEqual(budget.attempt.calls.map(call => call.ordinal), [1, 2, 3, 4, 5, 6, 7, 8, 9, null]);
const afterEight = await run("unknown-nine", [...Array(8)].map(() => ({ action: "status" })).concat(null), false);
assert.equal(afterEight.events.filter(event => event.kind === "group_go_sent").length, 8);

const unknownOnly = await run("unknown-only", Array(8).fill(null));
assert.equal(unknownOnly.events.filter(event => event.kind === "group_reserved").length, 0);
assert.equal(unknownOnly.attempt.calls.filter(call => call.result.text === "Tool bash not found").length, 8);
const unknownOnlyDenied = await run("unknown-only-nine", Array(10).fill(null), false);
assert.deepEqual(unknownOnlyDenied.attempt.calls.map(call => call.ordinal), [1, 2, 3, 4, 5, 6, 7, 8, 9, null]);
assert.equal(unknownOnlyDenied.events.filter(event => event.kind === "group_reserved").length, 0);
assert.equal(unknownOnlyDenied.attempt.calls.filter(call => call.result?.text === "Tool bash not found").length, 8);

const longSource = [...corpus.index.sourceIds].at(-1);
const large = await run("large-provider-history", Array.from({ length: 8 }, () => ({
	action: "read", original: true, ids: [longSource],
})));
const largePayloadBytes = Buffer.byteLength(large.loopback[1].bodyText);
assert.ok(largePayloadBytes > 128 * 1024, largePayloadBytes);
const largeToolResults = JSON.parse(large.loopback[1].bodyText).messages.filter(message => message.role === "tool");
assert.equal(largeToolResults.length, 8);
for (const [i, call] of large.attempt.calls.entries()) {
	assert.equal(call.result.isError, false);
	assert.equal(largeToolResults[i].content, call.result.text);
	assert.deepEqual(Buffer.from(call.result.text), readFileSync(join(large.capture, `lease-${i + 1}.native.stdout.bin`)));
}

const compareMutation = async (label, mutate, invariant) => {
	const copy = join(root, label);
	cpSync(good.result.root, copy, { recursive: true, errorOnExist: true, force: false });
	mutate(copy);
	const offline = inspectRun(copy, good.result.expected);
	assert.deepEqual(await sealRun(copy, good.result.expected), offline);
	assert.equal(offline.kind, "Invalid");
	assert.match(offline.invariant, invariant);
	return offline;
};
const mutations = {};
mutations.archive = await compareMutation("archive-drift", copy => appendFileSync(join(copy, "corpus", "corpus.sqlite.zst"), "extra"), /corpus_release_bytes/);
mutations.active = await compareMutation("active-drift", copy => {
	const active = join(copy, "attempts", good.attempt.identity.attemptId, "data", "active.json");
	appendFileSync(active, " ");
}, /SHA-256 mismatch.*active.json/);
mutations.skill = await compareMutation("skill-drift", copy => appendFileSync(join(copy, "skill.bin"), "extra"), /plan_profile/);
mutations.summary = await compareMutation("summary-drift", copy => {
	const path = join(copy, "summary.json");
	const saved = json(path);
	saved.summary.attempts[0].calls[0].result.text = "invented summary result";
	saved.sha256 = sha256Buffer(JSON.stringify(saved.summary));
	writeFileSync(path, JSON.stringify(saved));
}, /derived_summary/);

const liveFaults = {};
for (const kind of ["provider_grant", "group_go_sent", "native_exited"]) {
	const parent = join(root, `live-${kind}`);
	mkdirSync(parent);
	const append = BoundedJournalWriter.prototype.append;
	let seenCalls = 0;
	let changedPath;
	BoundedJournalWriter.prototype.append = async function (record, ...args) {
		const commit = await append.call(this, record, ...args);
		if (record.kind === kind && !changedPath) {
			const run = readdirSync(parent).find(entry => entry.startsWith("host-") && !entry.endsWith(".json"));
			changedPath = join(parent, run, "attempts", record.attemptId, "data", "active.json");
			appendFileSync(changedPath, " ");
		}
		return commit;
	};
	try {
		const result = await collectRun(plan, parent, dir, () => {
			seenCalls++;
			return calls([{ action: "status" }]);
		});
		assert.ok(changedPath, `${kind}: no drift injected`);
		assert.equal(seenCalls, kind === "provider_grant" ? 0 : 1);
		assert.equal(result.result.kind, "Incomplete");
		assert.deepEqual(inspectRun(result.root, result.expected), result.result);
		const [index] = readdirSync(join(result.root, "_index"));
		const owner = json(join(result.root, "_index", index));
		assert.equal(owner.uncertified, true);
		assert.match(owner.failureReason, /(?:File pin|Size or file type changed)/);
		assert.equal(owner.nativeStarts, kind === "native_exited" ? 1 : 0);
		assert.equal(journal(owner.rawArtifacts.journalPath).some(record => record.kind === "tool_result_delivered"), false);
		liveFaults[kind] = { changedPath, seenCalls, owner };
	} finally {
		BoundedJournalWriter.prototype.append = append;
	}
}
const owners = [good, denied, budget, afterEight, unknownOnly, unknownOnlyDenied, large].map(({ result }) => {
	const [index] = readdirSync(join(result.root, "_index"));
	return json(join(result.root, "_index", index));
}).concat(Object.values(liveFaults).map(fault => fault.owner));
const pids = owners.flatMap(owner => [owner.piPid, ...owner.groupObservations.flatMap(group => [group.helperPid, group.nativePid])]).filter(Boolean);
const pgids = owners.flatMap(owner => owner.groupObservations.map(group => group.pgid)).filter(Boolean);
const processTable = execFileSync("/bin/ps", ["-ax", "-o", "pid=,pgid="], { encoding: "utf8", env: buildScrubbedChildEnv({}) });
const survivors = processTable.trim().split("\n").filter(row => {
	const [pid, pgid] = row.trim().split(/\s+/).map(Number);
	return pids.includes(pid) || pgids.includes(pgid);
});
assert.deepEqual(survivors, []);
const receipt = join(root, "receipt.json");
writeExclusiveFile(receipt, JSON.stringify({
	profile, corpus: corpus.commitment, publishSha256, largePayloadBytes, pids, pgids, survivors, mutations, liveFaults,
	runs: [good, denied, budget, afterEight, unknownOnly, unknownOnlyDenied, large].map(({ result }) => ({ root: result.root, summary: result.result.summary })),
}));
console.log(receipt);
