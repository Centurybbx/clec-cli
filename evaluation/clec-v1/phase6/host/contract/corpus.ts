import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { sha256Buffer, verifyFilePin } from "../capture/pins.ts";
import { createExclusiveDir, parseRawJson, writeExclusiveFile } from "../capture/framing.ts";
import { isSha256Hex } from "./types.ts";
import { isPassageId, isReleaseHash, isSourceId, isWorkId } from "./request.ts";

const MANIFEST = "manifest.json";
const ARCHIVE = "corpus.sqlite.zst";
const ACTIVE = "active.json";
const MAX_METADATA = 65_536;
const MAX_CORPUS_FILE = 16 * 1024 * 1024;
const MAX_IDS = 4096;

function record(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	throw new Error("corpus_metadata");
}

function readBounded(dir: string, file: string, cap: number): Buffer {
	if (!lstatSync(dir).isDirectory()) throw new Error("corpus_directory");
	const fd = openSync(join(dir, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > cap) throw new Error("corpus_file_bound");
		const bytes = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < bytes.length) {
			const amount = readSync(fd, bytes, offset, bytes.length - offset, offset);
			if (!amount) throw new Error("corpus_file_truncated");
			offset += amount;
		}
		if (readSync(fd, Buffer.alloc(1), 0, 1, offset)) throw new Error("corpus_file_grew");
		return bytes;
	} finally {
		closeSync(fd);
	}
}

function ids<T extends string>(db: DatabaseSync, table: "works" | "sources" | "passages", valid: (value: unknown) => value is T) {
	const found = new Set<T>();
	for (const row of db.prepare(`SELECT id FROM ${table} ORDER BY id LIMIT ?`).iterate(MAX_IDS + 1)) {
		if (!valid(row.id) || found.has(row.id) || found.size >= MAX_IDS) throw new Error("corpus_index");
		found.add(row.id);
	}
	if (!found.size) throw new Error("corpus_index_empty");
	return found;
}

export type CorpusCommitment = ReturnType<typeof readPublicCorpus>["commitment"];

// The public fixture and retained corpus share this layout. The index is
// derived from the exact committed database, never supplied by the caller.
export function readPublicCorpus(dir: string) {
	if (!lstatSync(dir).isDirectory()) throw new Error("corpus_directory");
	dir = realpathSync(dir);
	const manifest = readBounded(dir, MANIFEST, MAX_METADATA);
	const metadata = record(parseRawJson(manifest));
	const release = metadata.sha256;
	if (!isReleaseHash(release) || metadata.artifact !== ARCHIVE || metadata.artifactUrl !== undefined ||
		!isSha256Hex(metadata.compressedSha256)) throw new Error("corpus_manifest");
	const archive = readBounded(dir, ARCHIVE, MAX_CORPUS_FILE);
	const active = readBounded(dir, ACTIVE, MAX_METADATA);
	const pointer = record(parseRawJson(active));
	if (pointer.release !== release || typeof pointer.manifestPath !== "string" ||
		!pointer.manifestPath.startsWith("/") || !pointer.manifestPath.endsWith("/manifest.json")) throw new Error("corpus_active_pointer");
	const databaseName = `${release}.sqlite`;
	const database = readBounded(dir, databaseName, MAX_CORPUS_FILE);
	if (metadata.bytes !== database.length || sha256Buffer(database) !== release ||
		metadata.compressedBytes !== archive.length || sha256Buffer(archive) !== metadata.compressedSha256) throw new Error("corpus_release_bytes");
	const databasePath = join(dir, databaseName);
	// Immutable read-only SQLite cannot incorporate a journal or WAL from
	// beside the database. The hash above covers the sole database input.
	const url = pathToFileURL(databasePath);
	url.searchParams.set("immutable", "1");
	const db = new DatabaseSync(url, { readOnly: true });
	try {
		const index = { release, workIds: ids(db, "works", isWorkId), sourceIds: ids(db, "sources", isSourceId),
			passageIds: ids(db, "passages", isPassageId) };
		const indexBytes = JSON.stringify([[...index.workIds], [...index.sourceIds], [...index.passageIds]]);
		const commitment = {
			release, manifest: sha256Buffer(manifest), archive: metadata.compressedSha256,
			activePointer: sha256Buffer(active), database: release, index: sha256Buffer(indexBytes),
		};
		return { index, commitment, manifestPath: pointer.manifestPath, files: { [MANIFEST]: manifest, [ARCHIVE]: archive, [ACTIVE]: active, [databaseName]: database } };
	} finally {
		db.close();
	}
}

export function retainCorpus(dir: string, corpus: ReturnType<typeof readPublicCorpus>): void {
	createExclusiveDir(dir);
	for (const [name, bytes] of Object.entries(corpus.files)) writeExclusiveFile(join(dir, name), bytes);
}

export function materializeCorpus(dir: string, corpus: ReturnType<typeof readPublicCorpus>) {
	const name = `${corpus.commitment.release}.sqlite`;
	writeExclusiveFile(join(dir, ACTIVE), corpus.files[ACTIVE]);
	writeExclusiveFile(join(dir, name), corpus.files[name]);
	return pinAttemptCorpus(dir, corpus.commitment);
}

function boundedPin(dir: string, name: string, cap: number, expected: CorpusCommitment["database"]) {
	const path = join(dir, name);
	const bytes = readBounded(dir, name, cap);
	const sha256 = sha256Buffer(bytes);
	if (sha256 !== expected) throw new Error(`SHA-256 mismatch for ${path}`);
	return { logicalPath: path, canonicalPath: path, sizeBytes: bytes.length, sha256 };
}

export function pinAttemptCorpus(dir: string, commitment: CorpusCommitment) {
	const names = [`${commitment.release}.sqlite`, ACTIVE];
	if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== dir) throw new Error("corpus_directory");
	if (readdirSync(dir).length !== names.length) throw new Error("corpus_file_inventory");
	return [
		boundedPin(dir, names[0], MAX_CORPUS_FILE, commitment.database),
		boundedPin(dir, names[1], MAX_METADATA, commitment.activePointer),
	];
}

export async function verifyAttemptCorpus(dir: string, pins: ReturnType<typeof pinAttemptCorpus>): Promise<void> {
	const names = await readdir(dir);
	if (names.length !== pins.length) throw new Error("corpus_file_inventory");
	for (const pin of pins) await verifyFilePin(pin);
}
