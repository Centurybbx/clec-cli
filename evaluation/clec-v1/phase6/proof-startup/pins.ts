import { execFileSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { asSha256Hex, type Sha256Hex } from "./types.ts";

export const PRIMARY_CLEC_BIN =
	"/tmp/clec-coordinator-install.Y1F9gC/prefix 空 格/lib/node_modules/@clec/cli/bin/clec.exe";
export const EXPECTED_CLEC_BIN_SHA256 = asSha256Hex(
	"083e4f86aad0e2962ea3033304b8f3b3c57b03b208e89311f5b972cbb135b1b7",
	"EXPECTED_CLEC_BIN_SHA256",
);

export const PRIMARY_CLEC_SKILL =
	"/tmp/clec-coordinator-install.Y1F9gC/prefix 空 格/lib/node_modules/@clec/cli/skills/clec/SKILL.md";
export const EXPECTED_CLEC_SKILL_SHA256 = asSha256Hex(
	"66031f09781b0ed95f610e607719bca0967c067a546656d8da83b3dc90d4eb9b",
	"EXPECTED_CLEC_SKILL_SHA256",
);

export const PI_RELEASE_ROOT = "/Users/century/.pi/agent/install/releases/1.5.2";
export const PI_BUNDLE_ENTRY =
	"/Users/century/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
export const EXPECTED_PI_ENTRY_SHA256 = asSha256Hex(
	"e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774",
	"EXPECTED_PI_ENTRY_SHA256",
);

const EXPECTED_NODE_SHA256 = asSha256Hex(
	"67252740eb6dadeff855b991ec85d7a7cf1d5d70ba7e68adf8d73b17df8a4b95", "Node 25.7.0",
);
const EXPECTED_PI_TREE_SHA256 = asSha256Hex(
	"8f37ccfd783605fb5390d8c17d861fe28657ccfd5899a6938e685131f4095baf", "Pi 1.5.2 tree",
);

export interface FilePin {
	readonly logicalPath: string;
	readonly canonicalPath: string;
	readonly sizeBytes: number;
	readonly sha256: Sha256Hex;
}

export interface ExecutionClosure {
	readonly capturedUtc: string;
	readonly platform: string;
	readonly arch: string;
	readonly nodeVersion: string;
	readonly nodePin: FilePin;
	readonly nativeSourceOrigin: "installed_temp_package";
	readonly nativePin: FilePin;
	readonly skillSourceOrigin: "installed_temp_package";
	readonly skillPin: FilePin;
	readonly piEntryPin: FilePin;
	readonly observerPin: FilePin;
	readonly piReleaseRoot: string;
	readonly piTreeFileCount: number;
	readonly piTreeByteCount: number;
	readonly piTreeSha256: Sha256Hex;
	readonly unit1Files: readonly FilePin[];
	readonly dynamicLibDeps: {
		readonly clecOtool: readonly string[];
		readonly nodeOtool: readonly string[];
	};
	readonly closureDigest: Sha256Hex;
}

export function sha256Buffer(buf: Buffer | Uint8Array | string): Sha256Hex {
	const hex = createHash("sha256").update(buf).digest("hex");
	return asSha256Hex(hex, "sha256Buffer");
}

export function sha256FileStreaming(filePath: string): { readonly sha256: Sha256Hex; readonly sizeBytes: number } {
	const stat = lstatSync(filePath);
	if (!stat.isFile()) {
		throw new Error(`Expected regular file for hashing: ${filePath}`);
	}
	const fd = openSync(filePath, "r");
	const chunk = Buffer.allocUnsafe(65_536);
	const hash = createHash("sha256");
	let total = 0;
	try {
		for (;;) {
			const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			hash.update(chunk.subarray(0, bytesRead));
			total += bytesRead;
		}
	} finally {
		closeSync(fd);
	}
	return {
		sha256: asSha256Hex(hash.digest("hex"), filePath),
		sizeBytes: total,
	};
}

export function pinRegularFile(logicalPath: string, expectedSha256?: Sha256Hex): FilePin {
	if (!existsSync(logicalPath)) {
		throw new Error(`Missing pinned file: ${logicalPath}`);
	}
	const canonicalPath = realpathSync(logicalPath);
	const { sha256, sizeBytes } = sha256FileStreaming(canonicalPath);
	if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
		throw new Error(`SHA-256 mismatch for ${logicalPath}: expected ${expectedSha256}, got ${sha256}`);
	}
	return {
		logicalPath,
		canonicalPath,
		sizeBytes,
		sha256,
	};
}

export function hashBoundedDirectoryTree(rootDir: string): {
	readonly canonicalRoot: string;
	readonly fileCount: number;
	readonly byteCount: number;
	readonly treeSha256: Sha256Hex;
} {
	const canonicalRoot = realpathSync(rootDir);
	const treeHash = createHash("sha256");
	const visitedDirs = new Set<string>([canonicalRoot]);
	let fileCount = 0;
	let byteCount = 0;

	const walk = (dir: string): void => {
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			const relPath = relative(canonicalRoot, fullPath);
			if (entry.isSymbolicLink()) {
				const resolved = realpathSync(fullPath);
				if (resolved !== canonicalRoot && !resolved.startsWith(`${canonicalRoot}/`)) {
					throw new Error(`Symlink escapes bounded root ${canonicalRoot}: ${fullPath} -> ${resolved}`);
				}
				const targetStat = lstatSync(resolved);
				if (targetStat.isDirectory()) {
					if (visitedDirs.has(resolved)) {
						throw new Error(`Directory symlink cycle in bounded tree: ${fullPath}`);
					}
					visitedDirs.add(resolved);
				}
				treeHash.update(`L:${relPath}->${relative(canonicalRoot, resolved)}\0`);
			} else if (entry.isDirectory()) {
				const resolved = realpathSync(fullPath);
				if (resolved !== canonicalRoot && !resolved.startsWith(`${canonicalRoot}/`)) {
					throw new Error(`Directory escapes bounded root ${canonicalRoot}: ${fullPath}`);
				}
				if (visitedDirs.has(resolved)) {
					throw new Error(`Directory cycle in bounded tree: ${fullPath}`);
				}
				visitedDirs.add(resolved);
				walk(fullPath);
			} else if (entry.isFile()) {
				const { sha256, sizeBytes } = sha256FileStreaming(fullPath);
				fileCount += 1;
				byteCount += sizeBytes;
				treeHash.update(`F:${relPath}:${sizeBytes}:${sha256}\0`);
			} else {
				throw new Error(`Unsupported filesystem entry in bounded tree: ${fullPath}`);
			}
		}
	};

	walk(canonicalRoot);
	return {
		canonicalRoot,
		fileCount,
		byteCount,
		treeSha256: asSha256Hex(treeHash.digest("hex"), canonicalRoot),
	};
}

function readOtoolDeps(binaryPath: string): readonly string[] {
	if (process.platform !== "darwin") {
		return [`unsupported_platform:${process.platform}`];
	}
	try {
		const out = execFileSync("otool", ["-L", binaryPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return out
			.split("\n")
			.slice(1)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	} catch (err) {
		return [`otool_error:${err instanceof Error ? err.message : String(err)}`];
	}
}

export function resolveUnit1RootDir(): string {
	return realpathSync(import.meta.dirname);
}

export async function verifyFilePin(pin: FilePin): Promise<void> {
	const file = await open(pin.canonicalPath, "r");
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size !== pin.sizeBytes) throw new Error(`Size or file type changed: ${pin.logicalPath}`);
		const hash = createHash("sha256");
		const chunk = Buffer.allocUnsafe(65_536);
		for (let offset = 0; offset < pin.sizeBytes;) {
			const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, pin.sizeBytes - offset), offset);
			if (bytesRead === 0) throw new Error(`File truncated: ${pin.logicalPath}`);
			hash.update(chunk.subarray(0, bytesRead));
			offset += bytesRead;
		}
		if (hash.digest("hex") !== pin.sha256) throw new Error(`File pin changed: ${pin.logicalPath}`);
	} finally {
		await file.close();
	}
}

export function captureExecutionClosure(): ExecutionClosure {
	const unit1Dir = resolveUnit1RootDir();
	const nodePin = pinRegularFile(process.execPath, EXPECTED_NODE_SHA256);
	const nativePin = pinRegularFile(PRIMARY_CLEC_BIN, EXPECTED_CLEC_BIN_SHA256);
	const skillPin = pinRegularFile(PRIMARY_CLEC_SKILL, EXPECTED_CLEC_SKILL_SHA256);
	const piEntryPin = pinRegularFile(PI_BUNDLE_ENTRY, EXPECTED_PI_ENTRY_SHA256);
	const observerPin = pinRegularFile("/bin/ps");
	const piTree = hashBoundedDirectoryTree(PI_RELEASE_ROOT);
	if (piTree.treeSha256 !== EXPECTED_PI_TREE_SHA256) throw new Error("Pinned Pi release tree has changed");

	const unit1Names = [
		"PROTOCOL.md",
		"tsconfig.json",
		"types.ts",
		"pins.ts",
		"framing.ts",
		"process-group.ts",
		"group-helper.mjs",
		"clec-adapter.ts",
		"controller.ts",
		"fixtures.ts",
		"run-matrix.ts",
		"process-observation.test.mjs",
		"deadline-controls.mjs",
	];
	const unit1Files: FilePin[] = [];
	for (const name of unit1Names) {
		const candidate = join(unit1Dir, name);
		unit1Files.push(pinRegularFile(candidate));
	}

	const dynamicLibDeps = {
		clecOtool: readOtoolDeps(nativePin.canonicalPath),
		nodeOtool: readOtoolDeps(nodePin.canonicalPath),
	};

	const closureDigest = sha256Buffer(
		JSON.stringify({
			platform: process.platform,
			arch: process.arch,
			nodeVersion: process.version,
			nodeSha: nodePin.sha256,
			nativeSha: nativePin.sha256,
			skillSha: skillPin.sha256,
			piEntrySha: piEntryPin.sha256,
			observerSha: observerPin.sha256,
			piTreeSha: piTree.treeSha256,
			unit1Files: unit1Files.map((f) => ({ path: f.logicalPath, sha: f.sha256 })),
			dynamicLibDeps,
		}),
	);

	return {
		capturedUtc: new Date().toISOString(),
		platform: process.platform,
		arch: process.arch,
		nodeVersion: process.version,
		nodePin,
		nativeSourceOrigin: "installed_temp_package",
		nativePin,
		skillSourceOrigin: "installed_temp_package",
		skillPin,
		piEntryPin,
		observerPin,
		piReleaseRoot: piTree.canonicalRoot,
		piTreeFileCount: piTree.fileCount,
		piTreeByteCount: piTree.byteCount,
		piTreeSha256: piTree.treeSha256,
		unit1Files,
		dynamicLibDeps,
		closureDigest,
	};
}

export function buildScrubbedChildEnv(overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
	const scrubbed: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		TERM: "dumb",
		NO_COLOR: "1",
		NODE_DISABLE_COMPILE_CACHE: "1",
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		...overrides,
	};
	return scrubbed;
}
