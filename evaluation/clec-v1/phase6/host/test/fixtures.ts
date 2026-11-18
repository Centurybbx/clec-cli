import { CLEC_TOOL_PARAMETERS_SCHEMA } from "../contract/request.ts";
export * from "../runner/loopback.ts";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type FaultAdapterKind =
	| "import_failure"
	| "setup_throw"
	| "session_start_throw"
	| "no_ready"
	| "early_eof"
	| "broken_channel"
	| "bash_drift"
	| "schema_drift"
	| "sync_serialization_err"
	| "async_channel_reject"
	| "eof_during_latch"
	| "unprotected_guard"
	| "stderr_flood";

export function writeFaultAdapterFixture(dir: string, kind: FaultAdapterKind): string {
	mkdirSync(dir, { recursive: true });
	const outPath = join(dir, `fault-adapter-${kind}.ts`);
	const realAdapterPath = resolve(import.meta.dirname, "../clec-tool.ts");

	let content = "";
	switch (kind) {
		case "import_failure":
			content = `import "./nonexistent-module-unit1.ts";\nexport default function () {}\n`;
			break;
		case "setup_throw":
			content = `export default function () {\n\tthrow new Error("fault_setup_throw");\n}\n`;
			break;
		case "session_start_throw":
			content = `import { Type } from "typebox";
export default function (pi: any) {
\tpi.registerTool({
\t\tname: "clec",
\t\tlabel: "CLEC",
\t\tdescription: "Fault",
\t\tparameters: Type.Unsafe(${JSON.stringify(CLEC_TOOL_PARAMETERS_SCHEMA)}),
\t\tasync execute() { return { content: [{ type: "text", text: "ok" }] }; },
\t});
\tpi.on("session_start", () => {
\t\tthrow new Error("fault_session_start_throw");
\t});
}\n`;
			break;
		case "no_ready":
			content = `import { Type } from "typebox";
export default function (pi: any) {
\tpi.registerTool({
\t\tname: "clec",
\t\tlabel: "CLEC",
\t\tdescription: "Fault",
\t\tparameters: Type.Unsafe(${JSON.stringify(CLEC_TOOL_PARAMETERS_SCHEMA)}),
\t\tasync execute() { return { content: [{ type: "text", text: "ok" }] }; },
\t});
}\n`;
			break;
		case "early_eof":
			content = `import { Socket } from "node:net";
export default function (pi: any) {
\tconst w = new Socket({ fd: 4 });
\tpi.on("session_start", () => {
\t\tw.destroy();
\t\treturn new Promise(() => {});
\t});
}\n`;
			break;
		case "broken_channel":
			content = `import { Socket } from "node:net";
export default function (pi: any) {
\tconst w = new Socket({ fd: 4 });
\tpi.on("session_start", () => {
\t\tw.write("NOT_VALID_JSON\\n");
\t\treturn new Promise(() => {});
\t});
}\n`;
			break;
		case "bash_drift":
			content = `import { Type } from "typebox";
import realAdapter from ${JSON.stringify(realAdapterPath)};
export default function (pi: any) {
\trealAdapter(pi);
\tpi.registerTool({
\t\tname: "bash",
\t\tlabel: "Bash Drift",
\t\tdescription: "Test-only tool drift",
\t\tparameters: Type.Object({ command: Type.String() }, { additionalProperties: false }),
\t\tasync execute() { return { content: [{ type: "text", text: "drift" }] }; },
\t});
}\n`;
			break;
		case "schema_drift":
			content = `import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { Type } from "typebox";
export default function (pi: any) {
\tconst r = new Socket({ fd: 3 });
\tconst w = new Socket({ fd: 4 });
\tlet readyCb: (() => void) | null = null;
\tr.on("data", (d) => {
\t\tfor (const line of d.toString("utf8").split("\\n")) {
\t\t\tif (!line.trim()) continue;
\t\t\tconst msg = JSON.parse(line);
\t\t\tif (msg.kind === "bound_ready_ack" && readyCb) {
\t\t\t\tconst cb = readyCb; readyCb = null; cb();
\t\t\t}
\t\t}
\t});
\tpi.registerTool({
\t\tname: "clec",
\t\tlabel: "CLEC",
\t\tdescription: "Drifted schema",
\t\tparameters: Type.Object({ action: Type.String(), extra: Type.Optional(Type.String()) }, { additionalProperties: true }),
\t\tasync execute() { return { content: [{ type: "text", text: "ok" }] }; },
\t});
\tpi.on("session_start", (_e: any, ctx: any) => new Promise<void>((res) => {
\t\treadyCb = res;
\t\tw.write(JSON.stringify({
\t\t\tkind: "bound_ready",
\t\t\tseq: 1,
\t\t\tactiveTools: pi.getActiveTools(),
\t\t\tallTools: [{ name: "clec", exposure: "direct", parameters: ${JSON.stringify(CLEC_TOOL_PARAMETERS_SCHEMA)} }],
\t\t\tdeferredTools: [],
\t\t\tmodel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
\t\t\tthinkingLevel: ctx.thinkingLevel ?? null,
\t\t}) + "\\n");
\t}));
\tpi.on("before_provider_request", (event: any) => new Promise(() => {
\t\tconst payloadJson = JSON.stringify(event.payload);
\t\tconst payloadDigest = createHash("sha256").update(payloadJson, "utf8").digest("hex");
\t\tw.write(JSON.stringify({
\t\t\tkind: "provider_candidate",
\t\t\tseq: 2,
\t\t\twatermark: 1,
\t\t\tpayloadDigest,
\t\t\tpayloadByteLength: Buffer.byteLength(payloadJson, "utf8"),
\t\t\tpayloadJson,
\t\t}) + "\\n");
\t}));
}\n`;
			break;
		case "sync_serialization_err":
			content = `import { Socket } from "node:net";
import { Type } from "typebox";
export default function (pi: any) {
\tconst r = new Socket({ fd: 3 });
\tconst w = new Socket({ fd: 4 });
\tlet readyCb: (() => void) | null = null;
\tr.on("data", (d) => {
\t\tfor (const line of d.toString("utf8").split("\\n")) {
\t\t\tif (!line.trim()) continue;
\t\t\tconst msg = JSON.parse(line);
\t\t\tif (msg.kind === "bound_ready_ack" && readyCb) {
\t\t\t\tconst cb = readyCb; readyCb = null; cb();
\t\t\t}
\t\t}
\t});
\tpi.registerTool({
\t\tname: "clec",
\t\tlabel: "CLEC Status",
\t\tdescription: "Fault sync serialization",
\t\tparameters: Type.Unsafe(${JSON.stringify(CLEC_TOOL_PARAMETERS_SCHEMA)}),
\t\tasync execute() { return { content: [{ type: "text", text: "ok" }] }; },
\t});
\tpi.on("session_start", (_e: any, ctx: any) => new Promise<void>((res) => {
\t\treadyCb = res;
\t\tw.write(JSON.stringify({
\t\t\tkind: "bound_ready",
\t\t\tseq: 1,
\t\t\tactiveTools: pi.getActiveTools(),
\t\t\tallTools: pi.getAllTools().filter((t: any) => t.sourceInfo?.source !== "builtin").map((t: any) => ({ name: t.name, exposure: t.exposure, parameters: t.parameters })),
\t\t\tdeferredTools: [],
\t\t\tmodel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
\t\t\tthinkingLevel: ctx.thinkingLevel ?? null,
\t\t}) + "\\n");
\t}));
\tpi.on("before_provider_request", () => new Promise((_resolve) => {
\t\ttry {
\t\t\tconst cyc: Record<string, unknown> = {};
\t\t\tcyc.self = cyc;
\t\t\tJSON.stringify(cyc);
\t\t} catch (err) {
\t\t\tw.write(JSON.stringify({ kind: "adapter_fault_note", stage: "before_provider_request", detail: "sync_ser:" + (err as Error).message }) + "\\n");
\t\t}
\t}));
}\n`;
			break;
		case "async_channel_reject":
			content = `import { Socket } from "node:net";
import { Type } from "typebox";
export default function (pi: any) {
\tconst r = new Socket({ fd: 3 });
\tconst w = new Socket({ fd: 4 });
\tlet readyCb: (() => void) | null = null;
\tr.on("data", (d) => {
\t\tfor (const line of d.toString("utf8").split("\\n")) {
\t\t\tif (!line.trim()) continue;
\t\t\tconst msg = JSON.parse(line);
\t\t\tif (msg.kind === "bound_ready_ack" && readyCb) {
\t\t\t\tconst cb = readyCb; readyCb = null; cb();
\t\t\t}
\t\t}
\t});
\tpi.registerTool({
\t\tname: "clec",
\t\tlabel: "CLEC Status",
\t\tdescription: "Fault async channel reject",
\t\tparameters: Type.Unsafe(${JSON.stringify(CLEC_TOOL_PARAMETERS_SCHEMA)}),
\t\tasync execute() { return { content: [{ type: "text", text: "ok" }] }; },
\t});
\tpi.on("session_start", (_e: any, ctx: any) => new Promise<void>((res) => {
\t\treadyCb = res;
\t\tw.write(JSON.stringify({
\t\t\tkind: "bound_ready",
\t\t\tseq: 1,
\t\t\tactiveTools: pi.getActiveTools(),
\t\t\tallTools: pi.getAllTools().filter((t: any) => t.sourceInfo?.source !== "builtin").map((t: any) => ({ name: t.name, exposure: t.exposure, parameters: t.parameters })),
\t\t\tdeferredTools: [],
\t\t\tmodel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
\t\t\tthinkingLevel: ctx.thinkingLevel ?? null,
\t\t}) + "\\n");
\t}));
\tpi.on("before_provider_request", () => new Promise((_resolve) => {
\t\tvoid Promise.reject(new Error("async_channel_rejected")).catch((err) => {
\t\t\tw.write(JSON.stringify({ kind: "adapter_fault_note", stage: "before_provider_request", detail: err.message }) + "\\n");
\t\t});
\t}));
}\n`;
			break;
		case "eof_during_latch":
			content = `import { Socket } from "node:net";
import { Type } from "typebox";
export default function (pi: any) {
\tconst r = new Socket({ fd: 3 });
\tconst w = new Socket({ fd: 4 });
\tlet readyCb: (() => void) | null = null;
\tr.on("data", (d) => {
\t\tfor (const line of d.toString("utf8").split("\\n")) {
\t\t\tif (!line.trim()) continue;
\t\t\tconst msg = JSON.parse(line);
\t\t\tif (msg.kind === "bound_ready_ack" && readyCb) {
\t\t\t\tconst cb = readyCb; readyCb = null; cb();
\t\t\t}
\t\t}
\t});
\tpi.registerTool({
\t\tname: "clec",
\t\tlabel: "CLEC Status",
\t\tdescription: "Fault EOF during latch",
\t\tparameters: Type.Unsafe(${JSON.stringify(CLEC_TOOL_PARAMETERS_SCHEMA)}),
\t\tasync execute() { return { content: [{ type: "text", text: "ok" }] }; },
\t});
\tpi.on("session_start", (_e: any, ctx: any) => new Promise<void>((res) => {
\t\treadyCb = res;
\t\tw.write(JSON.stringify({
\t\t\tkind: "bound_ready",
\t\t\tseq: 1,
\t\t\tactiveTools: pi.getActiveTools(),
\t\t\tallTools: pi.getAllTools().filter((t: any) => t.sourceInfo?.source !== "builtin").map((t: any) => ({ name: t.name, exposure: t.exposure, parameters: t.parameters })),
\t\t\tdeferredTools: [],
\t\t\tmodel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
\t\t\tthinkingLevel: ctx.thinkingLevel ?? null,
\t\t}) + "\\n");
\t}));
\tpi.on("before_provider_request", () => new Promise((_resolve) => {
\t\tw.end();
\t}));
}\n`;
			break;
		case "unprotected_guard":
			content = `import { Socket } from "node:net";
import { Type } from "typebox";
export default function (pi: any) {
\tconst r = new Socket({ fd: 3 });
\tconst w = new Socket({ fd: 4 });
\tlet readyCb: (() => void) | null = null;
\tr.on("data", (d) => {
\t\tfor (const line of d.toString("utf8").split("\\n")) {
\t\t\tif (!line.trim()) continue;
\t\t\tconst msg = JSON.parse(line);
\t\t\tif (msg.kind === "bound_ready_ack" && readyCb) {
\t\t\t\tconst cb = readyCb; readyCb = null; cb();
\t\t\t}
\t\t}
\t});
\tpi.registerTool({
\t\tname: "clec",
\t\tlabel: "CLEC Status",
\t\tdescription: "Test-only unprotected guard",
\t\tparameters: Type.Unsafe(${JSON.stringify(CLEC_TOOL_PARAMETERS_SCHEMA)}),
\t\tasync execute() { return { content: [{ type: "text", text: "ok" }] }; },
\t});
\tpi.on("session_start", (_e: any, ctx: any) => new Promise<void>((res) => {
\t\treadyCb = res;
\t\tw.write(JSON.stringify({
\t\t\tkind: "bound_ready",
\t\t\tseq: 1,
\t\t\tactiveTools: pi.getActiveTools(),
\t\t\tallTools: pi.getAllTools().filter((t: any) => t.sourceInfo?.source !== "builtin").map((t: any) => ({ name: t.name, exposure: t.exposure, parameters: t.parameters })),
\t\t\tdeferredTools: [],
\t\t\tmodel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
\t\t\tthinkingLevel: ctx.thinkingLevel ?? null,
\t\t}) + "\\n");
\t}));
\t// Intentionally violates nonrejecting latch by resolving undefined on error/denial
\tpi.on("before_provider_request", async () => {
\t\treturn undefined;
\t});
}\n`;
			break;
		case "stderr_flood":
			content = `import realAdapter from ${JSON.stringify(realAdapterPath)};
export default function (pi: any) {
\trealAdapter(pi);
\tpi.on("before_agent_start", () => {
\t\tprocess.stderr.write("S".repeat(80 * 1024) + "\\n");
\t});
}\n`;
			break;
	}
	writeFileSync(outPath, content, "utf8");
	return outPath;
}

export function writeFaultBinary(dir: string, name: string, jsBody: string): string {
	mkdirSync(dir, { recursive: true });
	const outPath = join(dir, name);
	writeFileSync(outPath, `#!${process.execPath}\n${jsBody}\n`, "utf8");
	chmodSync(outPath, 0o755);
	return outPath;
}

export function writeBypassGoHelperFixture(dir: string, sentinelPath: string): string {
	mkdirSync(dir, { recursive: true });
	const outPath = join(dir, "bypass-go-helper.mjs");
	writeFileSync(
		outPath,
		`import { writeFileSync } from "node:fs";
import { Socket } from "node:net";
const w = new Socket({ fd: 4 });
writeFileSync(${JSON.stringify(sentinelPath)}, "bypassed-go-before-registration\\n", "utf8");
let leaseId = "lease-1";
for (let i = 0; i < process.argv.length; i++) {
	if (process.argv[i] === "--lease") leaseId = process.argv[i + 1];
}
w.write(JSON.stringify({ kind: "helper_ready", leaseId, pid: process.pid, pgid: process.pid, lstart: null }) + "\\n");
setTimeout(() => process.exit(0), 200);
`,
		"utf8",
	);
	return outPath;
}

export function writeLeaderExitSurvivingChildHelper(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const outPath = join(dir, "leader-exit-helper.mjs");
	writeFileSync(
		outPath,
		`import { spawn } from "node:child_process";
import { Socket } from "node:net";
const r = new Socket({ fd: 3 });
const w = new Socket({ fd: 4 });
let leaseId = "lease-1";
for (let i = 0; i < process.argv.length; i++) {
	if (process.argv[i] === "--lease") leaseId = process.argv[i + 1];
}
w.write(JSON.stringify({ kind: "helper_ready", leaseId, pid: process.pid, pgid: process.pid, lstart: null }) + "\\n");
r.once("data", () => {
	const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
		detached: false,
		stdio: "ignore",
	});
	w.write(JSON.stringify({ kind: "native_started", leaseId, pid: child.pid, pgid: process.pid, lstart: null }) + "\\n");
	setTimeout(() => {
		w.end();
		process.exit(0);
	}, 60);
});
`,
		"utf8",
	);
	return outPath;
}
