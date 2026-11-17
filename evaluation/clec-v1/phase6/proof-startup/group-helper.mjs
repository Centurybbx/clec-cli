import { spawn } from "node:child_process";
import { Socket } from "node:net";

function parseArgs(argv) {
	let leaseId = null;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--lease" && i + 1 < argv.length) {
			leaseId = argv[++i];
		}
	}
	return { leaseId };
}

const { leaseId } = parseArgs(process.argv.slice(2));
if (!leaseId) {
	process.stderr.write("Missing --lease argument\n");
	process.exit(2);
}

const ctrlIn = new Socket({ fd: 3 });
const ctrlOut = new Socket({ fd: 4 });

let nativeChild = null;
let goHandled = false;
let exiting = false;

function writeFrame(obj) {
	return ctrlOut.write(`${JSON.stringify(obj)}\n`, "utf8");
}

function failAndExit(message, code = 1) {
	if (exiting) return;
	exiting = true;
	try {
		writeFrame({ kind: "helper_error", leaseId, message });
	} catch {
		// Pipe may already be closed
	}
	ctrlOut.end(() => process.exit(code));
}

writeFrame({
	kind: "helper_ready",
	leaseId,
	pid: process.pid,
	pgid: process.pid,
	lstart: null,
});

let lineChunks = [];
let lineBytes = 0;
const MAX_GO_FRAME_BYTES = 1024 * 1024;

ctrlIn.on("data", (chunk) => {
	if (goHandled || exiting) return;
	const nlIndex = chunk.indexOf(0x0a);
	if (nlIndex === -1) {
		if (lineBytes + chunk.length > MAX_GO_FRAME_BYTES) {
			failAndExit("GO frame exceeded 1 MiB cap", 2);
			return;
		}
		lineChunks.push(Buffer.from(chunk));
		lineBytes += chunk.length;
		return;
	}
	const tail = chunk.subarray(0, nlIndex);
	if (lineBytes + tail.length + 1 > MAX_GO_FRAME_BYTES) {
		failAndExit("GO frame exceeded 1 MiB cap", 2);
		return;
	}
	lineChunks.push(Buffer.from(tail));
	const complete = Buffer.concat(lineChunks, lineBytes + tail.length).toString("utf8").replace(/\r$/, "");
	lineChunks = [];
	lineBytes = 0;

	let msg;
	try {
		msg = JSON.parse(complete);
	} catch (err) {
		failAndExit(`Invalid GO JSON: ${err instanceof Error ? err.message : String(err)}`, 2);
		return;
	}
	if (!msg || msg.kind !== "go" || msg.leaseId !== leaseId || typeof msg.execPath !== "string" || !Array.isArray(msg.argv) || typeof msg.cwd !== "string") {
		failAndExit("Invalid GO command payload", 2);
		return;
	}
	goHandled = true;
	ctrlIn.pause();
	launchNative(msg);
});

ctrlIn.on("end", () => {
	if (!goHandled && !exiting) {
		exiting = true;
		ctrlOut.end(() => process.exit(0));
	}
});

ctrlIn.on("error", (err) => {
	if (!goHandled && !exiting) {
		failAndExit(`GO pipe error: ${err.message}`, 1);
	}
});

function launchNative(goCmd) {
	try {
		nativeChild = spawn(goCmd.execPath, goCmd.argv, {
			cwd: goCmd.cwd,
			env: process.env,
			shell: false,
			detached: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		failAndExit(`Spawn native failed: ${err instanceof Error ? err.message : String(err)}`, 1);
		return;
	}

	if (typeof nativeChild.pid === "number") {
		writeFrame({
			kind: "native_started",
			leaseId,
			pid: nativeChild.pid,
			pgid: process.pid,
			lstart: null,
		});
	}

	const forwardStream = (streamName, stream) => {
		if (!stream) return;
		stream.on("data", (buf) => {
			const ok = writeFrame({
				kind: "native_chunk",
				leaseId,
				stream: streamName,
				dataBase64: Buffer.from(buf).toString("base64"),
			});
			if (!ok) {
				stream.pause();
				ctrlOut.once("drain", () => {
					if (!exiting) stream.resume();
				});
			}
		});
	};

	forwardStream("stdout", nativeChild.stdout);
	forwardStream("stderr", nativeChild.stderr);

	nativeChild.on("error", (err) => {
		failAndExit(`Native child error: ${err.message}`, 1);
	});

	nativeChild.on("close", (code, signal) => {
		if (exiting) return;
		exiting = true;
		writeFrame({
			kind: "native_exited",
			leaseId,
			exitCode: code,
			signal: signal ?? null,
		});
		ctrlOut.end(() => process.exit(0));
	});
}

process.on("SIGTERM", () => {
	if (nativeChild && nativeChild.exitCode === null && nativeChild.signalCode === null) {
		try {
			nativeChild.kill("SIGTERM");
		} catch {
			// Ignore if already exited
		}
		return;
	}
	if (!goHandled && !exiting) {
		exiting = true;
		ctrlOut.end(() => process.exit(0));
	}
});
