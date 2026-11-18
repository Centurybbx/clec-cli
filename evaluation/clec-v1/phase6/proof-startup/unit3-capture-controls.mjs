import assert from "node:assert/strict";
import cp from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { frames } from "./artifacts.ts";
import { runUnit1Proof } from "./controller.ts";
import { startUnit1LoopbackOpenAI, writeFaultBinary } from "./fixtures.ts";
import { attachBoundedJsonlReader, writeExclusiveFile } from "./framing.ts";
import { captureExecutionClosure, sha256Buffer } from "./pins.ts";
import { UNIT1_LIMITS as L } from "./types.ts";

const root = fs.mkdtempSync(join(process.argv[2] ?? "/tmp", "clec-unit3-capture-"));
const closure = captureExecutionClosure();
const cases = {};
const pids = new Set();
const pgids = new Set();
const spawn = cp.spawn;
const kill = process.kill;
const open = fsPromises.open;
const probe = await open(join(root, "write-probe"), "wx", 0o600);
const handle = Object.getPrototypeOf(probe);
await probe.close();
const write = handle.write;
const capturedFiles = new WeakMap();
const signals = [];
let pi;
let stdoutChunks = 0;

function observe(knownPids = pids, knownPgids = pgids) {
	const rows = cp.execFileSync("/bin/ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8" }).trim().split("\n");
	return rows.map(row => row.trim()).filter(row => {
		const [pid, pgid] = row.split(/\s+/).map(Number);
		return knownPids.has(pid) || knownPgids.has(pgid);
	});
}

async function attempt(name, { faults = {}, text, tool = false } = {}) {
	const dir = join(root, name);
	fs.mkdirSync(dir, { mode: 0o700 });
	const server = await startUnit1LoopbackOpenAI(({ seq }) => tool && seq === 1
		? { kind: "tool_calls", calls: [{ id: "capture-status", name: "clec", rawArgumentsJson: '{"action":"status"}' }] }
		: { kind: "text", text: text ?? "Synthetic capture answer." });
	try {
		const result = await runUnit1Proof({
			caseLabel: name, evidenceParentDir: dir, question: "Public synthetic capture control.",
			mockBaseUrl: server.baseUrl, faults: { caseDeadlineMsOverride: 12_000, ...faults },
		}, { cachedClosure: closure });
		for (const group of result.groupObservations) {
			for (const pid of [group.nativePid, group.helperPid]) if (pid) pids.add(pid);
			if (group.pgid) pgids.add(group.pgid);
		}
		assert.deepEqual(observe(new Set([result.piPid, ...result.groupObservations
			.flatMap(group => [group.nativePid, group.helperPid])]), new Set(result.groupObservations
			.map(group => group.pgid))), []);
		const journal = fs.readFileSync(result.rawArtifacts.journalPath);
		const events = Array.from(frames(journal), frame => frame.value);
		const index = fs.readFileSync(result.indexEntryPath);
		assert.deepEqual(JSON.parse(index), JSON.parse(JSON.stringify(result)));
		const paths = result.rawArtifacts;
		const receipt = {
			status: result.status, uncertified: result.uncertified, reason: result.failureReason,
			piPid: result.piPid, stop: result.piStop, drain: result.captureDrain, groups: result.groupObservations,
			requestCount: server.requests.length, raw: paths, index: result.indexEntryPath, indexSha256: sha256Buffer(index),
		};
		cases[name] = receipt;
		return { result, receipt, events, paths, requests: server.requests };
	} finally {
		await server.close();
	}
}

function native(name, js, faults = {}) {
	return attempt(name, { tool: true, faults: {
		nativeExecOverride: writeFaultBinary(root, name + ".mjs", js),
		nativeArgsOverride: [], ...faults,
	} });
}

function assertOverflow(run, stream, cap) {
	assert.equal(run.result.status, "InvalidEvidence");
	assert.equal(run.result.uncertified, true);
	const overflow = run.events.find(event => event.kind === "overflow_uncertified");
	assert.equal(overflow?.body.stream, stream);
	assert.ok(overflow.body.observedBytes > cap);
	run.receipt.overflow = overflow.body;
}

function assertPiStopped(run) {
	const { piStop: stop, piPid, piSignal, piExitCode } = run.result;
	assert.ok(signals.some(call => call.pid === piPid && call.signal === "SIGTERM" && call.at <= stop.signalDeadline));
	assert.ok(stop.reapedAt >= stop.triggerAt && stop.reapedAt <= stop.observationDeadline);
	if (stop.killAttemptAt !== null) {
		assert.ok(signals.some(call => call.pid === piPid && call.signal === "SIGKILL" && call.at <= stop.signalDeadline));
		assert.equal(piSignal, "SIGKILL");
	} else {
		assert.equal(stop.noKillReason, "Direct child reaped");
		assert.ok(piExitCode !== null || piSignal !== null);
	}
}

function exact(receipt, path, expected) {
	const bytes = fs.readFileSync(path);
	assert.deepEqual(bytes, expected);
	(receipt.bytes ??= {})[path] = { size: bytes.length, sha256: sha256Buffer(bytes) };
}

const binary = length => Buffer.from(Array.from({ length }, (_, i) => (113 + 37 * i) % 256));
const stderr = binary(L.nativeStderrBytes);
const nativePath = (run, stream) => join(dirname(run.paths.journalPath), `lease-1.native.${stream}.bin`);
function nativeChunks(run) {
	const path = join(dirname(run.paths.journalPath), "lease-1.native.chunks.jsonl");
	return Array.from(frames(fs.readFileSync(path)), frame => frame.value);
}
async function nativeControls() {
	const head = Buffer.from([0xef, 0xbb, 0xbf, 0xe2]);
	const tail = Buffer.concat([Buffer.from([0x82, 0xac]), Buffer.alloc(L.nativeStdoutBytes - 6, 97)]);
	const positive = await native("native-split", `
		process.stdout.write(Buffer.from(${JSON.stringify(head.toString("hex"))}, "hex"));
		await new Promise(resolve => setTimeout(resolve, 180));
		process.stdout.write(Buffer.from(${JSON.stringify(tail.toString("base64"))}, "base64"));
		process.stderr.write(Buffer.from(${JSON.stringify(stderr.toString("base64"))}, "base64"));
	`);
	assert.equal(positive.result.status, "Answered");
	assert.equal(positive.result.uncertified, false);
	const stdout = Buffer.concat([head, tail]);
	exact(positive.receipt, nativePath(positive, "stdout"), stdout);
	exact(positive.receipt, nativePath(positive, "stderr"), stderr);
	const chunks = nativeChunks(positive);
	assert.deepEqual(chunks.filter(rec => rec.stream === "stdout").map(rec => rec.bytes), [head.length, tail.length]);
	const toolResult = Array.from(frames(fs.readFileSync(positive.paths.piStdoutPath)), frame => frame.value)
		.find(rec => rec.type === "message_end" && rec.message?.role === "toolResult")?.message;
	assert.equal(toolResult?.isError, false);
	assert.deepEqual(Buffer.from(toolResult.content[0].text), stdout);
	assert.equal(positive.requests.length, 2);
	const wireResult = positive.requests[1].bodyJson.messages.find(msg => msg.role === "tool").content;
	const wireText = typeof wireResult === "string" ? wireResult : wireResult.map(part => part.text).join("");
	assert.deepEqual(Buffer.from(wireText), stdout);
	positive.receipt.resultSha256 = sha256Buffer(wireText);
	positive.receipt.chunks = chunks;

	for (const [stream, cap] of [["stdout", L.nativeStdoutBytes], ["stderr", L.nativeStderrBytes]]) {
		const payload = binary(cap + 251);
		const run = await native(`native-${stream}-overflow`, `
			process.${stream}.write(Buffer.from(${JSON.stringify(payload.toString("base64"))}, "base64"));
			setTimeout(() => {}, 10_000);
		`);
		assertOverflow(run, `lease-1:${stream}`, cap);
		exact(run.receipt, nativePath(run, stream), payload.subarray(0, cap));
		let retained = 0;
		for (const chunk of nativeChunks(run)) {
			assert.equal(chunk.stream, stream);
			assert.equal(chunk.offset, retained);
			retained += chunk.bytes;
			assert.equal(chunk.sha256, sha256Buffer(payload.subarray(chunk.offset, retained)));
		}
		assert.equal(retained, cap);
		assert.equal(run.requests.length, 1);
		assert.equal(run.result.groupObservations[0].closure?.kind, "gone");
	}
	const invalid = await native("native-invalid-utf8", "process.stdout.write(Buffer.from([0xc3, 0xff]));");
	assert.equal(invalid.result.failureReason, "Successful native stdout is invalid UTF-8");
	assert.equal(invalid.result.status, "InvalidEvidence");
	assert.equal(invalid.result.uncertified, true);
	exact(invalid.receipt, nativePath(invalid, "stdout"), Buffer.from([0xc3, 0xff]));
	assert.equal(invalid.requests.length, 1);
	assert.ok(!invalid.events.some(event => event.kind === "tool_result_delivered"));

	const timeout = await native("native-timeout", `
		process.on("SIGTERM", () => {});
		process.stdout.write("native timeout prefix");
		setInterval(() => {}, 1000);
	`, { nativeDeadlineMsOverride: 1_100 });
	assert.equal(timeout.result.status, "DeniedAndTerminated");
	assert.match(timeout.result.failureReason, /Native command exceeded 1100 ms deadline/);
	const group = timeout.result.groupObservations[0];
	assert.equal(group.closure?.kind, "gone");
	assert.equal(group.stop.triggerAt, timeout.result.piStop.triggerAt);
	assert.ok(group.stop.killAttemptAt >= group.stop.triggerAt + 400);
	assert.ok(group.stop.killAttemptAt <= group.stop.signalDeadline);
	assert.ok(signals.some(call => call.pid === -group.pgid && call.signal === "SIGKILL" && call.at <= group.stop.signalDeadline));
	exact(timeout.receipt, nativePath(timeout, "stdout"), Buffer.from("native timeout prefix"));
	assert.equal(timeout.requests.length, 1);
}

const paddingStart = '{"type":"unit3_padding","pad":"';
const paddingEnd = '"}\n';
const padding = Buffer.from(paddingStart + "R".repeat(L.maxPendingSinkBytes - paddingStart.length - paddingEnd.length) + paddingEnd);
const piStderr = binary(L.maxPendingSinkBytes);
function floodFixture(name, stream, block, repeats) {
	const path = join(root, name + ".ts");
	writeExclusiveFile(path, `
		import { once } from "node:events";
		import { Writable } from "node:stream";
		import realAdapter from ${JSON.stringify(join(import.meta.dirname, "clec-adapter.ts"))};
		export default function (pi) {
			realAdapter(pi);
			process.on("SIGTERM", () => {});
			pi.on("before_agent_start", async () => {
				const stream = process.${stream};
				const block = Buffer.from(${JSON.stringify(block.toString("base64"))}, "base64");
				for (let n = 0; n < ${repeats}; n++) {
					// Pi routes extension stdout through stderr in RPC mode.
					if (!Writable.prototype.write.call(stream, block)) await once(stream, "drain");
				}
				return new Promise(() => {});
			});
		}
	`);
	return path;
}

async function piCaps() {
	for (const [stream, block, cap] of [["stdout", padding, L.piStdoutBytes], ["stderr", piStderr, L.piStderrBytes]]) {
		const run = await attempt(`pi-${stream}-overflow`, { faults: {
			adapterPathOverride: floodFixture(`flood-${stream}`, stream, block, cap / block.length + 2),
		} });
		assertOverflow(run, `pi_${stream}`, cap);
		const path = stream === "stdout" ? run.paths.piStdoutPath : run.paths.piStderrPath;
		const raw = fs.readFileSync(path);
		assert.equal(raw.length, cap);
		const start = stream === "stdout" ? raw.indexOf(paddingStart) : 0;
		assert.ok(start >= 0 && start < L.maxPendingSinkBytes);
		if (stream === "stdout") assert.ok(Array.from(frames(raw.subarray(0, start))).length > 0);
		for (let offset = start; offset < cap; offset += block.length) {
			assert.deepEqual(raw.subarray(offset, offset + block.length), block.subarray(0, Math.min(block.length, cap - offset)));
		}
		run.receipt.bytes = { size: raw.length, sha256: sha256Buffer(raw), floodOffset: start };
		assert.equal(run.requests.length, 0);
		assertPiStopped(run);
	}
	for (const extra of [0, 1]) {
		const text = "£".repeat(L.answerBytes / 2) + "x".repeat(extra);
		const run = await attempt(`answer-${extra}`, { text });
		assert.equal(run.result.status, extra ? "InvalidEvidence" : "Answered");
		assert.equal(run.result.uncertified, Boolean(extra));
		if (extra) assert.match(run.result.failureReason, /Answer text exceeded 65536 bytes/);
		else assert.equal(run.result.answerText, text);
		const answer = Array.from(frames(fs.readFileSync(run.paths.piStdoutPath)), frame => frame.value)
			.find(rec => rec.type === "message_end" && rec.message?.role === "assistant");
		assert.equal(answer.message.content[0].text, text);
		run.receipt.answerBytes = Buffer.byteLength(text);
	}
}

async function controlCaps() {
	for (const [name, size, count] of [
		["frame", L.controlFrameBytes, 1],
		["aggregate", 256 * 1024, L.controlAggregateBytes / (256 * 1024)],
	]) {
		const error = Promise.withResolvers();
		const pipe = new PassThrough();
		let records = 0;
		const reader = attachBoundedJsonlReader({
			stream: pipe, label: name, maxFrameBytes: L.controlFrameBytes, maxAggregateBytes: L.controlAggregateBytes,
			onRecord: async () => { records++; }, onError: err => error.resolve(err),
		});
		const block = Buffer.alloc(L.maxPendingSinkBytes, 97);
		for (let n = 0; n <= count; n++) {
			for (let offset = 0; offset < size && !pipe.destroyed; offset += block.length) {
				const owned = Buffer.allocUnsafeSlow(block.length);
				block.copy(owned);
				if (offset === 0) owned[0] = 34;
				if (offset + block.length === size && (name !== "frame" || n < count)) {
					owned[owned.length - 2] = 34;
					owned[owned.length - 1] = 10;
				}
				pipe.write(owned);
				await nextTurn();
			}
			if (name === "frame" && n === count) break;
		}
		if (!pipe.destroyed) pipe.end();
		const outcome = await reader.done;
		assert.equal(outcome.kind, "incomplete");
		const fault = await error.promise;
		const cap = name === "frame" ? L.controlFrameBytes : L.controlAggregateBytes;
		assert.equal(fault.limitBytes, cap);
		assert.ok(fault.observedBytes > cap);
		assert.equal(records, count);
		cases[`control-${name}`] = { cap, observed: fault.observedBytes, records, outcome };
	}
}

const fifoReader = `
import os, sys, time, hashlib, json
fifo, marker = sys.argv[1:]
fd = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
print("ready", flush=True)
while not os.path.exists(marker): time.sleep(.005)
with open(marker) as f: count, payload = map(int, f.read().split())
os.set_blocking(fd, True)
time.sleep(4.5)
release = time.time_ns() / 1000000
digest = hashlib.sha256()
read = 0
while read < count + payload:
    buf = os.read(fd, min(65536, count + payload - read))
    if not buf: raise RuntimeError("unexpected EOF")
    digest.update(buf[max(0, count-read):])
    read += len(buf)
print(json.dumps(dict(releaseWallMs=release, bytes=read-count, sha256=digest.hexdigest())), flush=True)
os.close(fd)
`;

const asyncWrite = (fd, buffer, offset, length) => new Promise((resolve, reject) => {
	fs.write(fd, buffer, offset, length, null, (err, count) => err ? reject(err) : resolve(count));
});

async function slowStdout() {
	const fifo = join(root, "stdout.pipe");
	const marker = join(root, "stdout-pending");
	cp.execFileSync("/usr/bin/mkfifo", ["-m", "600", fifo]);
	const reader = spawn("/usr/bin/python3", ["-c", fifoReader, fifo, marker], { stdio: ["ignore", "pipe", "inherit"] });
	pids.add(reader.pid);
	const exited = once(reader, "close");
	const [ready] = await once(reader.stdout, "data");
	assert.equal(String(ready), "ready\n");
	let readerOutput = "";
	reader.stdout.on("data", chunk => { readerOutput += chunk; });
	const fill = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
	const fd = fs.openSync(fifo, fs.constants.O_WRONLY);
	let filled = 0;
	const stalled = Promise.withResolvers();
	let pending;
	let peakBuffered = 0;
	let sampler;
	try {
		const block = Buffer.alloc(L.maxPendingSinkBytes);
		while (filled < 1024 * 1024) {
			try { filled += fs.writeSync(fill, block); }
			catch (err) {
				assert.equal(err.code, "EAGAIN");
				break;
			}
		}
		assert.ok(filled > 0 && filled < 1024 * 1024);
		handle.write = function (buffer, offset, length) {
			if (!capturedFiles.get(this)?.endsWith("/pi.stdout.jsonl") || !buffer.includes(paddingStart)) {
				return write.call(this, buffer, offset, length);
			}
			assert.equal(pending, undefined, "stalled raw sink admitted another write");
			const owned = buffer.subarray(offset, offset + length);
			pending = {
				started: performance.now(), wallMs: Date.now(), bytes: length, backing: buffer.buffer.byteLength,
				sha256: sha256Buffer(owned), chunksAtStart: stdoutChunks, bufferedAtStart: pi.stdout.readableLength,
			};
			assert.ok(length > 0 && length <= L.maxPendingSinkBytes);
			assert.equal(pending.backing, buffer.length);
			sampler = setInterval(() => {
				peakBuffered = Math.max(peakBuffered, pi.stdout.readableLength);
			}, 10);
			writeExclusiveFile(marker + ".pending", `${filled} ${length}`);
			fs.renameSync(marker + ".pending", marker);
			void (async () => {
				try {
					assert.equal(await asyncWrite(fd, buffer, offset, length), length);
					assert.equal(sha256Buffer(owned), pending.sha256);
					pending.completed = performance.now();
					const result = await write.call(this, buffer, offset, length);
					stalled.resolve(result);
				} catch (err) { stalled.reject(err); }
			})();
			return stalled.promise;
		};

		const runWork = attempt("pi-stdout-stalled", { faults: {
			adapterPathOverride: floodFixture("stalled-stdout", "stdout", padding, 8),
			caseDeadlineMsOverride: 1_800,
		} });
		const result = await runWork;
		const stop = result.result.piStop;
		assert.equal(result.result.status, "DeniedAndTerminated");
		assert.match(result.result.failureReason, /Case deadline 1800 ms exceeded/);
		assert.equal(result.result.uncertified, true);
		assert.equal(result.result.captureDrain.kind, "incomplete");
		assert.equal(result.result.piSignal, "SIGKILL");
		assert.ok(stop.reapedAt > stop.killAttemptAt && stop.reapedAt <= stop.observationDeadline);
		assert.equal(pending.completed, undefined);
		const observed = signals.find(call => call.pid === result.result.piPid && call.signal === "SIGKILL");
		assert.ok(observed.at >= stop.triggerAt + 350 && observed.at <= stop.signalDeadline);
		assert.ok(pending.started < stop.triggerAt);
		assert.equal(stdoutChunks, pending.chunksAtStart);
		assert.ok(peakBuffered <= L.maxPendingSinkBytes);
		const index = fs.readFileSync(result.result.indexEntryPath);
		await stalled.promise;
		assert.deepEqual(await exited, [0, null]);
		const external = JSON.parse(readerOutput);
		assert.equal(external.bytes, pending.bytes);
		assert.equal(external.sha256, pending.sha256);
		assert.ok(external.releaseWallMs - pending.wallMs > 2_200);
		assert.ok(observed.wallMs < external.releaseWallMs);
		assert.deepEqual(fs.readFileSync(result.result.indexEntryPath), index);
		const raw = fs.readFileSync(result.paths.piStdoutPath);
		assert.equal(sha256Buffer(raw.subarray(-pending.bytes)), pending.sha256);
		result.receipt.block = { ...pending, external, kill: observed, peakBuffered, laterFileBytes: raw.length };
	} finally {
		clearInterval(sampler);
		handle.write = write;
		if (reader.exitCode === null && reader.signalCode === null) reader.kill("SIGKILL");
		await exited;
		fs.closeSync(fd);
		fs.closeSync(fill);
	}
}

async function failingStderr() {
	const failurePath = join(root, "read-only-fd-probe");
	writeExclusiveFile(failurePath, "Read-only descriptor test.");
	const failed = await open(failurePath, "r");
	let count = 0;
	handle.write = function (buffer, offset, length) {
		if (!capturedFiles.get(this)?.endsWith("/pi.stderr.bin")) return write.call(this, buffer, offset, length);
		count++;
		if (count === 1) return write.call(this, buffer, offset, 7);
		return write.call(failed, buffer, offset, length);
	};
	try {
		const run = await attempt("pi-stderr-failed", { faults: {
			adapterPathOverride: floodFixture("failed-stderr", "stderr", piStderr, 8),
		} });
		assert.equal(run.result.status, "InvalidEvidence");
		assert.equal(run.result.uncertified, true);
		assert.match(run.result.failureReason, /pi_stderr: EBADF/);
		assert.equal(run.result.captureDrain.kind, "incomplete");
		assertPiStopped(run);
		assert.equal(count, 2);
		assert.equal(run.requests.length, 0);
		exact(run.receipt, run.paths.piStderrPath, piStderr.subarray(0, 7));
		run.receipt.writeCalls = count;
	} finally {
		handle.write = write;
		await failed.close();
	}
}

try {
	cp.spawn = function (path, args, options) {
		const child = spawn(path, args, options);
		if (child.pid) pids.add(child.pid);
		if (child.pid && options?.detached) pgids.add(child.pid);
		if (args?.includes("--mode") && args?.includes("rpc")) {
			pi = child;
			stdoutChunks = 0;
			// The owner's readable listener remains responsible for pulling.
			child.stdout.on("data", () => { stdoutChunks++; });
			const childKill = child.kill.bind(child);
			child.kill = signal => {
				signals.push({ pid: child.pid, signal, at: performance.now(), wallMs: Date.now() });
				return childKill(signal);
			};
		}
		return child;
	};
	process.kill = function (pid, signal) {
		if (signal !== 0 && (pids.has(pid) || pgids.has(-pid))) signals.push({ pid, signal, at: performance.now(), wallMs: Date.now() });
		return kill.call(this, pid, signal);
	};
	fsPromises.open = async function (path, ...args) {
		const file = await open(path, ...args);
		capturedFiles.set(file, path);
		return file;
	};
	syncBuiltinESMExports();
	await nativeControls();
	await controlCaps();
	await piCaps();
	await slowStdout();
	await failingStderr();
	const survivors = observe();
	assert.deepEqual(survivors, []);
	const receipt = join(root, "receipt.json");
	writeExclusiveFile(receipt, JSON.stringify({ closure, limits: L, cases, signals, pids: [...pids], pgids: [...pgids], survivors }, null, 2));
	console.log(receipt);
} finally {
	cp.spawn = spawn;
	process.kill = kill;
	fsPromises.open = open;
	handle.write = write;
	syncBuiltinESMExports();
}
