import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

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

export async function startSyntheticLoopback(
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
