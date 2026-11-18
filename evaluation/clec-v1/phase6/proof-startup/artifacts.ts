import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { frameRange, parseRawJson, type FrameRange } from "./framing.ts";
import { sha256Buffer } from "./pins.ts";
import { UNIT1_LIMITS } from "./types.ts";

export function readEvidence(root: string, path: string, cap: number): Buffer {
	const parts = path.split("/");
	if (parts.some(part => !part || part === "." || part === ".." || !/^[A-Za-z0-9_.:-]+$/.test(part))) {
		throw new Error("artifact_path");
	}
	let current = realpathSync(root);
	try {
		for (const [i, part] of parts.entries()) {
			current = join(current, part);
			const entry = lstatSync(current);
			if (entry.isSymbolicLink() || (i < parts.length - 1 ? !entry.isDirectory() : !entry.isFile())) {
				throw new Error("artifact_path");
			}
		}
		const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const { size, nlink } = fstatSync(fd);
			if (nlink !== 1 || realpathSync(current) !== current) throw new Error("artifact_path");
			if (size > cap) throw new Error("artifact_limit");
			// At most one extra byte, even if a file grows after fstat.
			const bytes = Buffer.alloc(size + 1);
			let offset = 0;
			while (offset < bytes.length) {
				const count = readFilePart(fd, bytes, offset);
				if (count === 0) break;
				offset += count;
			}
			if (offset !== size) throw new Error("artifact_size");
			return bytes.subarray(0, size);
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error("missing_artifact");
		throw error;
	}
}

function readFilePart(fd: number, bytes: Buffer, offset: number): number {
	return readSync(fd, bytes, offset, bytes.length - offset, offset);
}

export function artifactRef(path: string, role: string, bytes: Buffer) {
	return { path, role, offset: 0, length: bytes.length, sha256: sha256Buffer(bytes) };
}

export function* frames(bytes: Buffer, cap = UNIT1_LIMITS.controlFrameBytes): Generator<{ value: unknown; range: FrameRange }> {
	for (let offset = 0; offset < bytes.length;) {
		const newline = bytes.indexOf(10, offset);
		if (newline === -1 || newline - offset + 1 > cap) throw new Error("raw_frame");
		const line = bytes.subarray(offset, newline);
		yield { value: parseRawJson(line), range: frameRange(line, offset) };
		offset = newline + 1;
	}
}
