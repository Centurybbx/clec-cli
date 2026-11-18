import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";

export interface RecordedLoopbackRequest {
	readonly seq: number;
	readonly method: string;
	readonly url: string;
	readonly baseUrl: string;
	readonly receivedAt: number;
	readonly authorizationPresent: boolean;
	readonly bodyText: string;
	readonly bodyJson: Record<string, unknown>;
}

export type MockOpenAIAction =
	| {
			readonly kind: "text";
			readonly text: string;
			readonly finishReason?: "stop" | "length" | "content_filter";
	  }
	| {
			readonly kind: "tool_calls";
			readonly calls: ReadonlyArray<{
				readonly id: string;
				readonly name: string;
				readonly rawArgumentsJson: string;
			}>;
	  }
	| { readonly kind: "transport_reset" }
	| {
			readonly kind: "http_error";
			readonly status: number;
			readonly body: string;
	  };

type LoopbackOutcome =
	| { readonly kind: "text"; readonly text: string; readonly finishReason: "stop" | "length" | "content_filter" }
	| { readonly kind: "tool_calls"; readonly calls: readonly WireToolCall[] }
	| { readonly kind: "transport_reset" }
	| { readonly kind: "http_error"; readonly status: number; readonly body: string };

type WireToolCall = { readonly id: string; readonly type: "function"; readonly function: {
	readonly name: string; readonly arguments: string;
} };

export interface LoopbackOpenAIServer {
	readonly baseUrl: string;
	readonly requests: RecordedLoopbackRequest[];
	readonly outcomes: LoopbackOutcome[];
	close(): Promise<void>;
}

function sendSse(res: ServerResponse, payload: unknown): void {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function startUnit1LoopbackOpenAI(
	responder: (req: RecordedLoopbackRequest) => MockOpenAIAction | Promise<MockOpenAIAction>,
): Promise<LoopbackOpenAIServer> {
	const requests: RecordedLoopbackRequest[] = [];
	const outcomes: LoopbackOutcome[] = [];
	let seq = 0;

	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", async () => {
			const bodyText = Buffer.concat(chunks).toString("utf8");
			let bodyJson: Record<string, unknown> = {};
			try {
				bodyJson = JSON.parse(bodyText) as Record<string, unknown>;
			} catch {
				bodyJson = {};
			}
			const recorded: RecordedLoopbackRequest = {
				seq: ++seq,
				method: req.method ?? "POST",
				url: req.url ?? "/",
				baseUrl: `http://${req.socket.localAddress}:${req.socket.localPort}/v1`,
				receivedAt: performance.now(),
				authorizationPresent: typeof req.headers.authorization === "string" && req.headers.authorization.length > 0,
				bodyText,
				bodyJson,
			};
			requests.push(recorded);

			const action = await responder(recorded);
			if (action.kind === "transport_reset") {
				req.socket.destroy();
				if (req.socket.destroyed) outcomes[recorded.seq - 1] = { kind: "transport_reset" };
				return;
			}
			const observeFinish = (outcome: LoopbackOutcome): void => {
				res.once("finish", () => { outcomes[recorded.seq - 1] = outcome; });
			};
			const model = typeof bodyJson.model === "string" ? bodyJson.model : "mock-gpt";
			const id = `chatcmpl-u1-${recorded.seq}`;
			const created = Math.floor(Date.now() / 1000);

			if (action.kind === "http_error") {
				res.writeHead(action.status, { "content-type": "application/json" });
				observeFinish({ kind: "http_error", status: res.statusCode, body: action.body });
				res.end(action.body);
				return;
			}

			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});

			if (action.kind === "text") {
				const text = action.text;
				const finishReason = action.finishReason ?? "stop";
				sendSse(res, {
					id,
					object: "chat.completion.chunk",
					created,
					model,
					choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
				});
				sendSse(res, {
					id,
					object: "chat.completion.chunk",
					created,
					model,
					choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
				});
				sendSse(res, {
					id,
					object: "chat.completion.chunk",
					created,
					model,
					choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
					usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
				});
				res.write("data: [DONE]\n\n");
				observeFinish({ kind: "text", text, finishReason });
				res.end();
				return;
			}

			const calls = action.calls.map((call): WireToolCall => ({
				id: call.id, type: "function", function: { name: call.name, arguments: call.rawArgumentsJson },
			}));
			sendSse(res, {
				id,
				object: "chat.completion.chunk",
				created,
				model,
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: calls.map((c, idx) => ({
								index: idx,
								id: c.id,
								type: c.type,
								function: { name: c.function.name, arguments: "" },
							})),
						},
						finish_reason: null,
					},
				],
			});
			for (const [idx, call] of calls.entries()) {
				sendSse(res, {
					id,
					object: "chat.completion.chunk",
					created,
					model,
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: idx,
										function: { arguments: call.function.arguments },
									},
								],
							},
							finish_reason: null,
						},
					],
				});
			}
			sendSse(res, {
				id,
				object: "chat.completion.chunk",
				created,
				model,
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				usage: { prompt_tokens: 50, completion_tokens: 15, total_tokens: 65 },
			});
			res.write("data: [DONE]\n\n");
			observeFinish({ kind: "tool_calls", calls });
			res.end();
		});
	});

	await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
	const addr = server.address();
	if (!addr || typeof addr === "string") {
		throw new Error("Failed to bind loopback OpenAI mock server");
	}
	return {
		baseUrl: `http://127.0.0.1:${addr.port}/v1`,
		requests,
		outcomes,
		close: () =>
			new Promise<void>((res, rej) => {
				server.close((err) => (err ? rej(err) : res()));
			}),
	};
}

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
	const realAdapterPath = resolve(import.meta.dirname, "clec-adapter.ts");

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
\t\tparameters: Type.Object({ action: Type.Literal("status") }, { additionalProperties: false }),
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
\t\tparameters: Type.Object({ action: Type.Literal("status") }, { additionalProperties: false }),
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
\t\t\tallTools: [{ name: "clec", exposure: "direct", parameters: { type: "object", additionalProperties: false, properties: { action: { const: "status", type: "string" } }, required: ["action"] } }],
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
\t\tparameters: Type.Object({ action: Type.Literal("status") }, { additionalProperties: false }),
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
\t\tparameters: Type.Object({ action: Type.Literal("status") }, { additionalProperties: false }),
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
\t\tparameters: Type.Object({ action: Type.Literal("status") }, { additionalProperties: false }),
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
\t\tparameters: Type.Object({ action: Type.Literal("status") }, { additionalProperties: false }),
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
