import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { modelsBytes, settingsBytes } from "../../phase6/host/contract.ts";
import { readPublicCorpus } from "../../phase6/host/contract/corpus.ts";
import { buildScrubbedChildEnv, pinRegularFile, verifyFilePin } from "../../phase6/host/capture/pins.ts";
import { startSyntheticLoopback } from "../../phase6/host/runner/loopback.ts";
import { PARAMETERS, PROFILE, requestArgs } from "./profile.mjs";

const [, , outArgument, piArgument] = process.argv;
if (!outArgument || !piArgument) throw new Error("Usage: node verify.mjs NEW_OUTPUT PI_CLI_JS");
const out = resolve(outArgument);
const pi = pinRegularFile(resolve(piArgument));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const bin = pinRegularFile(join(repo, "native/target/release/clec"));
const skill = pinRegularFile(join(repo, "cli/skills/clec/SKILL.md"));
const tool = pinRegularFile(fileURLToPath(new URL("./tool.mjs", import.meta.url)));
const adapter = pinRegularFile(fileURLToPath(new URL("./profile.mjs", import.meta.url)));
const state = join(out, "state"), pkg = join(out, "snapshot"), workspace = join(out, "fixture");
const config = join(out, "agent"), trace = join(out, "tools.jsonl");
mkdirSync(out, { mode: 0o700 });
for (const dir of [workspace, config]) mkdirSync(dir);
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const readTrace = () => readFileSync(trace, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
const works = [], sources = [];
for (let i = 0; i < 26; i++) {
	const key = `work-${i}`;
	const path = i === 25 ? "dense.srt" : `${i}.txt`;
	const subtitle = Array.from({ length: 80 }, (_, n) =>
		`${n + 1}\n00:00:01,001 --> 00:00:02,020\n稠密字幕及定位 ${n}\n`).join("\n");
	works.push({ key, title: "共同定位 " + '引號"\\😀'.repeat(90) });
	sources.push({ work: key, path, title: works.at(-1).title, role: i === 25 ? "transcript" : "document",
		attribution: "authored_fixture", quality: "fixture", status: "ready" });
	writeFileSync(join(workspace, path), i === 25 ? subtitle : `共同定位 ${i}。` + '引號"\\😀'.repeat(70));
}
const intake = join(out, "intake.json");
save(intake, { schemaVersion: 1, works, sources });
execFileSync(join(dirname(bin.canonicalPath), "clec-publish"),
	["--workspace", workspace, "--intake", intake, "--output", pkg]);
execFileSync(bin.canonicalPath, ["--offline", "--data-dir", state, "sync", "--manifest", join(pkg, "manifest.json")]);
for (const name of ["manifest.json", "corpus.sqlite.zst"]) copyFileSync(join(pkg, name), join(state, name));
const corpus = readPublicCorpus(state);
const release = corpus.index.release;
const sourceBytes = readFileSync(join(workspace, "dense.srt"));
const search = { action: "search", queries: ["共同定位"], limit: 20 };
const pins = { nativePath: bin.canonicalPath, dataDir: state, release };
for (const limit of [5, 20, 50]) {
	assert.ok(requestArgs({ ...search, limit }, corpus.index, pins).includes(`--limit=${limit}`));
}
for (const limit of [51, 4.5]) {
	assert.throws(() => requestArgs({ ...search, limit }, corpus.index, pins), /INVALID_REQUEST/);
}
for (const offset of [0, 10]) {
	assert.ok(requestArgs({ ...search, offset }, corpus.index, pins).includes(`--offset=${offset}`));
}
for (const offset of [-1, 1.5]) {
	assert.throws(() => requestArgs({ ...search, offset }, corpus.index, pins), /INVALID_REQUEST/);
}
assert.throws(() => requestArgs({ ...search, cues: true }, corpus.index, pins), /INVALID_REQUEST/);
assert.throws(() => requestArgs({ ...search, queries: ["中".repeat(171)] }, corpus.index, pins), /INVALID_REQUEST/);
assert.throws(() => requestArgs({ action: "read", ids: ["p_" + "0".repeat(24)] }, corpus.index, pins), /UNKNOWN_CORPUS_ID/);
let firstSearchPid, pid, responderError, searchRequired, readRequired, wideBytes, readBytes;
const server = await startSyntheticLoopback(({ seq, bodyJson, url }) => {
	try {
		assert.equal(url, "/v1/chat/completions");
		assert.equal(bodyJson.tools.length, 1);
		assert.equal(bodyJson.tools[0].function.name, "clec");
		assert.equal(bodyJson.tools[0].function.parameters.properties.limit.description, PARAMETERS.properties.limit.description);
		let last;
		if (seq > 1) {
			const records = readTrace();
			const results = bodyJson.messages.filter(message => message.role === "tool");
			assert.equal(results.length, seq - 1);
			for (const [i, message] of results.entries()) {
				assert.equal(message.tool_call_id, `clec-call-${i + 1}`);
				assert.equal(message.content, records[i].text);
				if (records[i].exitCode === 0) assert.equal(message.content, records[i].stdout);
			}
			last = records.at(-1);
		}
		let input;
		switch (seq) {
			case 1: input = { ...search, maxBytes: 1 }; break;
			case 2:
				searchRequired = JSON.parse(last.text).error.requiredBytes;
				assert.deepEqual(JSON.parse(last.text).error.retry, { maxBytes: searchRequired });
				input = { ...search, maxBytes: searchRequired }; break;
			case 3: {
				const data = JSON.parse(last.text).data;
				assert.equal(data.release, release);
				assert.equal(Buffer.byteLength(last.text), searchRequired);
				assert.equal(data.hits.length, 1);
				assert.equal(data.budget.omittedCount, 19);
				assert.equal(data.hasMore, true);
				assert.equal(data.nextOffset, 1);
				firstSearchPid = data.hits[0].passageId;
				input = { ...search, offset: 1, limit: 20 };
				break;
			}
			case 4: {
				const data = JSON.parse(last.text).data;
				wideBytes = Buffer.byteLength(last.text);
				assert.equal(data.release, release);
				assert.equal(data.offset, 1);
				assert.equal(new Set(data.hits.map(hit => hit.passageId)).size, 20);
				assert.ok(!data.hits.some(hit => hit.passageId === firstSearchPid));
				assert.equal(data.budget.omittedCount, 0);
				assert.ok(wideBytes <= 32768);
				input = { action: "search", queries: ["稠密字幕"], role: "transcript", limit: 1 };
				break;
			}
			case 5:
				pid = JSON.parse(last.text).data.hits[0].passageId;
				input = { action: "read", ids: [pid], release: "0".repeat(64), cues: true }; break;
			case 6:
				assert.equal(last.exitCode, -1);
				assert.equal(last.text, "VERSION_UNAVAILABLE");
				input = { action: "read", ids: [pid], release, cues: true, maxBytes: 1 }; break;
			case 7:
				readRequired = JSON.parse(last.text).error.requiredBytes;
				assert.deepEqual(JSON.parse(last.text).error.retry, { maxBytes: readRequired });
				input = { action: "read", ids: [pid], release, cues: true, maxBytes: readRequired }; break;
			case 8: {
				const data = JSON.parse(last.text).data;
				const item = data.items[0];
				readBytes = Buffer.byteLength(last.text);
				assert.equal(readBytes, readRequired);
				assert.ok(wideBytes + readBytes <= 65536);
				assert.ok(last.argv.includes(`--release=${release}`));
				assert.ok(last.argv.includes("--cues"));
				assert.equal(data.release, release);
				assert.equal(item.passageId, pid);
				assert.ok(item.cues.length > 20);
				assert.ok(item.cues.every(c => c.startMs === 1001 && c.endMs === 2020));
				assert.equal(item.text, item.spans.map(s => sourceBytes.subarray(s.startByte, s.endByte).toString("utf8")).join("\n"));
				return { kind: "text", text: "CLEC delivery verified." };
			}
			default: throw new Error("Unexpected extra request");
		}
		return { kind: "tool_calls", calls: [{ id: `clec-call-${seq}`, name: "clec", rawArgumentsJson: JSON.stringify(input) }] };
	} catch (error) {
		responderError = error;
		return { kind: "http_error", status: 500, body: '{"error":"fixture assertion failed"}' };
	}
});
try {
	const model = "clec-delivery", provider = "clec-loopback";
	writeFileSync(join(config, "models.json"), modelsBytes(provider, model, server.baseUrl));
	writeFileSync(join(config, "settings.json"), settingsBytes(provider, model, "off"));
	const system = readFileSync(skill.canonicalPath, "utf8") +
		"\nUse the sole clec tool. Search takes action and queries. Read takes action, ids, release and optional cues.\n";
	const flags = ["--offline", "--no-session", "--no-extensions", "--no-builtin-tools", "--no-mcp",
		"--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
		"-e", tool.canonicalPath, "--mode", "json", "--print", "--model", `${provider}/${model}`,
		"--thinking", "off", "--system-prompt", system, "--", "驗證本地搜尋與讀取。"];
	const child = spawn(process.execPath, [pi.canonicalPath, ...flags], {
		cwd: workspace,
		env: buildScrubbedChildEnv({ HOME: out, PI_CODING_AGENT_DIR: config,
			CLEC_CORPUS: state, CLEC_BIN: bin.canonicalPath, CLEC_BIN_SHA256: bin.sha256,
			CLEC_PI_PACKAGE: resolve(dirname(pi.canonicalPath), "../.."), CLEC_TRACE: trace }),
		stdio: ["ignore", "pipe", "pipe"], signal: AbortSignal.timeout(90_000),
	});
	const outputs = { stdout: [], stderr: [] };
	for (const name of ["stdout", "stderr"]) child[name].on("data", chunk => outputs[name].push(chunk));
	const exitCode = await new Promise((done, fail) => { child.once("error", fail); child.once("close", done); });
	const stdout = Buffer.concat(outputs.stdout), stderr = Buffer.concat(outputs.stderr);
	writeFileSync(join(out, "pi.jsonl"), stdout);
	writeFileSync(join(out, "pi.stderr"), stderr);
	save(join(out, "loopback.json"), server.requests);
	if (responderError) throw responderError;
	assert.equal(exitCode, 0, stderr.toString());
	assert.equal(server.requests.length, 8);
	assert.match(stdout.toString(), /CLEC delivery verified\./);
	assert.deepEqual(readPublicCorpus(state).commitment, corpus.commitment);
	await Promise.all([pi, bin, skill, tool, adapter].map(verifyFilePin));
	save(join(out, "receipt.json"), {
		profile: PROFILE, pi, bin, skill, tool, adapter, nodeVersion: process.version,
		piVersion: execFileSync(process.execPath, [pi.canonicalPath, "--version"], {
			env: buildScrubbedChildEnv({ HOME: out, PI_CODING_AGENT_DIR: config }),
		}).toString().trim(),
		corpus: corpus.commitment, wideBytes, readBytes,
		perCallCap: 32768, cumulativeTwoCallCap: 65536, providerRequests: 8,
		nativeCalls: readTrace().filter(item => item.argv).length,
	});
	console.log(join(out, "receipt.json"));
} finally {
	await server.close();
}
