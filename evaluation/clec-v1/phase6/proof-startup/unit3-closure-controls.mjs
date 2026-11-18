import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { publicProfile } from "./contract.ts";
import { runUnit1Proof } from "./controller.ts";
import { writeExclusiveFile } from "./framing.ts";
import { buildScrubbedChildEnv, captureExecutionClosure, sha256Buffer, sha256FileStreaming, verifyExecutionClosure } from "./pins.ts";
import { collectRun, inspectRun } from "./runner.ts";

const exec = promisify(execFile);
const [parent, mode] = process.argv.slice(2);
assert(parent, "Pass an existing private output directory");

function clone(source, target, recursive = false) {
	execFileSync("/bin/cp", recursive ? ["-cRP", source, target] : ["-c", source, target]);
}

async function checkClosure(root, closure) {
	const fixture = join(root, "inert-fixture");
	fs.mkdirSync(fixture, { mode: 0o700 });
	const sourceRoot = join(fixture, "proof");
	fs.mkdirSync(sourceRoot, { mode: 0o700 });
	for (const pin of closure.unit1Files) clone(pin.canonicalPath, join(sourceRoot, relative(import.meta.dirname, pin.logicalPath)));
	const paths = { sourceRoot, node: join(fixture, "node"), piRoot: join(fixture, "pi") };
	clone(closure.nodePin.canonicalPath, paths.node);
	fs.chmodSync(paths.node, 0o600);
	clone(closure.piReleaseRoot, paths.piRoot, true);
	const original = captureExecutionClosure(paths);
	assert.equal(verifyExecutionClosure(original, paths).closureDigest, original.closureDigest);
	assert.equal(verifyExecutionClosure(closure).closureDigest, closure.closureDigest);
	const rejected = {};
	const saved = join(fixture, "saved");
	fs.mkdirSync(saved, { mode: 0o700 });

	function mutate(name, path, alter, reason) {
		const backup = join(saved, name);
		fs.renameSync(path, backup);
		try {
			alter(path, backup);
			let error;
			assert.throws(() => verifyExecutionClosure(original, paths), err => {
				error = err.message;
				return reason.test(error);
			});
			rejected[name] = { path, error };
		} finally {
			// Keep the tampered fixture bytes as well as the original.
			fs.renameSync(path, backup + ".tampered");
			fs.renameSync(backup, path);
		}
	}
	const changed = (path, backup) => {
		clone(backup, path);
		fs.appendFileSync(path, "\n/* Unit 3 inert source mutation */\n");
	};
	for (const name of ["clec-adapter.ts", "group-helper.mjs", "contract.ts", "validate.ts", "framing.ts"]) {
		mutate(name, join(sourceRoot, name), changed, /^closure_prelaunch$/);
	}
	mutate("node", paths.node, changed, /SHA-256 mismatch.*\/node/);

	// cli.js loads cli-runtime.js, whose static imports execute the selected chunk.
	// A successful real Pi owner run below exercises that same installed entry.
	const entry = fs.readFileSync(original.piEntryPin.canonicalPath, "utf8");
	assert.match(entry, /createRequire\(import\.meta\.url\)\("\.\/cli-runtime\.js"\)/);
	const runtime = join(dirname(original.piEntryPin.canonicalPath), "cli-runtime.js");
	const specifier = /from"(\.\/chunks\/chunk-[A-Z0-9]+\.js)"/.exec(fs.readFileSync(runtime, "utf8"))?.[1];
	assert.ok(specifier);
	const chunk = join(dirname(runtime), specifier);
	mutate("loaded-chunk", chunk, changed, /Pinned Pi release tree has changed/);
	mutate("escaping-pi-link", chunk, path => fs.symlinkSync(closure.piEntryPin.canonicalPath, path), /Symlink escapes bounded root/);
	const controller = join(sourceRoot, "controller.ts");
	mutate("source-symlink", controller, path => fs.symlinkSync(join(saved, "source-symlink"), path), /Expected regular pinned file/);
	for (const [name, statement, diagnostic] of [
		["escaping-import", 'import "../outside.ts";', /Host import escapes proof root/],
		["missing-import", 'import "./unresolved.ts";', /Unlisted host import.*unresolved\.ts/],
		["external-import", 'import "unlisted-package";', /Unlisted external host import/],
		["dynamic-import", 'import("./types.ts");', /Dynamic host import/],
	]) {
		mutate(name, controller, (path, backup) => {
			clone(backup, path);
			fs.appendFileSync(path, "\n" + statement + "\n");
		}, diagnostic);
	}

	// Exercise the launcher's actual gate with a different committed root.
	// Verification precedes evidence allocation, sockets and child spawn.
	const refused = join(root, "never-allocated");
	await assert.rejects(runUnit1Proof({
		caseLabel: "refused", evidenceParentDir: refused, question: "Synthetic.",
		mockBaseUrl: "http://127.0.0.1:1/v1",
	}, { cachedClosure: original }), /closure_prelaunch/);
	assert.equal(fs.existsSync(refused), false);
	assert.equal(verifyExecutionClosure(original, paths).closureDigest, original.closureDigest);
	assert.equal(verifyExecutionClosure(closure).closureDigest, closure.closureDigest);
	return { original, chunk: relative(paths.piRoot, chunk), rejected, evidenceAllocatedOnRefusal: false };
}

function snapshot(dir) {
	const entries = [];
	function walk(base) {
		for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(base, entry.name);
			if (entry.isDirectory()) walk(path);
			else {
				assert.ok(entry.isFile(), path);
				entries.push({ path: relative(dir, path), ...sha256FileStreaming(path) });
			}
		}
	}
	walk(dir);
	return entries;
}

async function retention(root) {
	const evidence = join(root, "retention");
	fs.mkdirSync(evidence, { mode: 0o700 });
	const launch = () => exec(process.execPath, [import.meta.filename, evidence, "--collect"], {
		env: buildScrubbedChildEnv({ TMPDIR: root }), timeout: 35_000,
	}).then(({ stdout }) => JSON.parse(stdout));
	const first = await launch();
	const before = snapshot(evidence);
	const together = await Promise.all([launch(), launch()]);
	const afterConcurrent = snapshot(evidence);
	const rerun = await launch();
	const afterRerun = snapshot(evidence);
	const byPath = new Map(afterRerun.map(entry => [entry.path, entry]));
	for (const entry of [...before, ...afterConcurrent]) assert.deepEqual(byPath.get(entry.path), entry);
	const concurrentByPath = new Map(afterConcurrent.map(entry => [entry.path, entry]));
	for (const entry of before) assert.deepEqual(concurrentByPath.get(entry.path), entry);
	const runs = [first, ...together, rerun];
	assert.equal(new Set(runs.map(run => run.root)).size, runs.length);
	for (const run of runs) {
		assert.ok(run.pids.length >= 3 && run.pgids.length >= 1);
		assert.ok(byPath.has(relative(evidence, run.root) + ".expected.json"));
		assert.ok(byPath.has(relative(evidence, run.root) + ".final.json"));
		assert.ok(afterRerun.some(entry => entry.path.startsWith(relative(evidence, run.root) + "/_index/")));
		const expected = JSON.parse(fs.readFileSync(run.anchorPath, "utf8"));
		assert.equal(inspectRun(run.root, expected).kind, "Complete");
	}
	const pids = new Set(runs.flatMap(run => run.pids));
	const pgids = new Set(runs.flatMap(run => run.pgids));
	const survivors = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8" })
		.trim().split("\n").filter(row => {
			const [pid, pgid] = row.trim().split(/\s+/).map(Number);
			return pids.has(pid) || pgids.has(pgid);
		});
	assert.deepEqual(survivors, []);
	return { runs, before, afterConcurrent, afterRerun, pids: [...pids], pgids: [...pgids], survivors };
}

if (mode === "--collect") {
	const profile = publicProfile(captureExecutionClosure());
	const question = "Public synthetic status retention control.";
	const run = await collectRun({
		version: 1, profile, cases: [{ id: "retained", question, questionSha256: sha256Buffer(question) }],
	}, parent, (_, seq) => seq === 1
		? { kind: "tool_calls", calls: [{ id: "retained-status", name: "clec", rawArgumentsJson: '{"action":"status"}' }] }
		: { kind: "text", text: "Synthetic status recorded." });
	assert.equal(run.result.kind, "Complete", JSON.stringify(run.result));
	assert.equal(run.result.summary.attempts[0].status, "Answered");
	assert.deepEqual(inspectRun(run.root, run.expected), run.result);
	const indexDir = join(run.root, "_index");
	const [index] = fs.readdirSync(indexDir);
	const owner = JSON.parse(fs.readFileSync(join(indexDir, index), "utf8"));
	const pids = [process.pid, owner.piPid, ...owner.groupObservations.flatMap(group => [group.helperPid, group.nativePid])].filter(Boolean);
	const pgids = owner.groupObservations.map(group => group.pgid).filter(Boolean);
	console.log(JSON.stringify({ root: run.root, anchorPath: run.anchorPath, pids, pgids }));
} else {
	const root = fs.mkdtempSync(join(parent, "clec-unit3-closure-"));
	const closure = captureExecutionClosure();
	const verification = await checkClosure(root, closure);
	const retained = await retention(root);
	const receipt = join(root, "receipt.json");
	writeExclusiveFile(receipt, JSON.stringify({ closure, verification, retained }, null, 2));
	console.log(receipt);
}
