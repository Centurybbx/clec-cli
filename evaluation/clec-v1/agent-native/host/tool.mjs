import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { readPublicCorpus } from "../../phase6/host/contract/corpus.ts";
import { pinRegularFile, verifyFilePin } from "../../phase6/host/capture/pins.ts";
import { DESCRIPTION, PARAMETERS, runTool } from "./profile.mjs";

export default function register(pi) {
	const require = createRequire(join(process.env.CLEC_PI_PACKAGE, "package.json"));
	const { Type } = require("typebox");
	const { index } = readPublicCorpus(process.env.CLEC_CORPUS);
	const binary = pinRegularFile(process.env.CLEC_BIN, process.env.CLEC_BIN_SHA256);
	const pins = { nativePath: binary.canonicalPath, dataDir: process.env.CLEC_CORPUS, release: index.release };
	let attempts = 0;
	pi.registerTool({
		name: "clec", label: "CLEC", description: DESCRIPTION,
		parameters: Type.Unsafe(PARAMETERS), executionMode: "sequential",
		async execute(callId, input) {
			let record;
			try {
				if (++attempts > 8) throw new Error("TOOL_BUDGET_EXHAUSTED");
				await verifyFilePin(binary);
				record = runTool(input, index, pins);
			} catch (error) {
				record = { exitCode: -1, text: error instanceof Error ? error.message : "TOOL_ERROR" };
			}
			appendFileSync(process.env.CLEC_TRACE, JSON.stringify({ callId, input, ...record }) + "\n", { mode: 0o600 });
			return { content: [{ type: "text", text: record.text }], details: {}, isError: record.exitCode !== 0 };
		},
	});
	pi.on("session_start", () => {
		const active = pi.getActiveTools();
		if (active.length !== 1 || active[0] !== "clec") throw new Error("Expected only the clec tool");
	});
}
