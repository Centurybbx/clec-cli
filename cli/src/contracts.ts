import { createHash } from "node:crypto";

export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_REFERENCE"
  | "INVALID_QUERY"
  | "INVALID_URL"
  | "NO_DATA"
  | "VERSION_UNAVAILABLE"
  | "EVIDENCE_NOT_FOUND"
  | "BUSY"
  | "SYNC_LOCKED"
  | "CLEANUP_BLOCKED"
  | "INSUFFICIENT_SPACE"
  | "INVALID_DATA_DIR"
  | "TRANSFER_FAILED"
  | "TRANSFER_TOO_LARGE"
  | "INVALID_PACKAGE"
  | "INTEGRITY_MISMATCH"
  | "EMPTY_CORPUS"
  | "INVALID_MANIFEST"
  | "OUTPUT_EXISTS"
  | "PACKAGE_TOO_LARGE"
  | "SOURCE_TOO_LARGE"
  | "UNSAFE_PATH"
  | "CONFIG_SAVE_FAILED"
  | "IO_ERROR"
  | "INTERNAL_ERROR";
export class ClecError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: { inputIndex?: number; release?: string } = {},
  ) {
    super(message);
  }
}
export const hash = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
export const isHash = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
export const validDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
export type SourceType =
  | "document"
  | "qa"
  | "transcript"
  | "curated"
  | "metadata";
export type IntakeStatus =
  | "ready"
  | "quarantined"
  | "unsupported"
  | "metadata_only";
export interface IntakeSource {
  path: string;
  title: string;
  type: SourceType;
  quality: string;
  status: IntakeStatus;
  date?: string;
  dateBasis?: string;
  origin?: string;
}
export interface Source extends Omit<IntakeSource, "date" | "dateBasis"> {
  id: string;
  version: string;
  contentHash: string;
  date: string | undefined;
  dateBasis: string | undefined;
}
export interface Section {
  id: string;
  sourceId: string;
  sourceVersion: string;
  order: number;
  start: number;
  end: number;
  boundary: "whole" | "heading" | "contiguous";
}
export interface Inventory {
  path: string;
  status: string;
  reason: string;
  contentHash?: string;
}
export interface Counts {
  sources: number;
  sections: number;
  inventory: number;
}
export interface Manifest {
  formatRevision: 1;
  artifact: "corpus.sqlite";
  artifactUrl?: string;
  bytes: number;
  sha256: string;
  counts: Counts;
}
export const SEGMENTATION_REVISION = "original-utf16-v2-bounded-qa";
export const MAX_ARTIFACT = 2 * 1024 ** 3;
export const RESERVE = 5 * 1024 ** 3;
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ClecError("INVALID_PACKAGE", "Expected an object.");
  return value as Record<string, unknown>;
}
export function field(
  value: Record<string, unknown>,
  name: string,
  maximum = 4096,
): string {
  const result = value[name];
  if (
    typeof result !== "string" ||
    !result.trim() ||
    result.length > maximum ||
    result.includes("\0")
  )
    throw new ClecError("INVALID_PACKAGE", `Invalid ${name}.`);
  return result;
}
export function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new ClecError(
      "INVALID_ARGUMENT",
      `Expected integer in ${minimum}..${maximum}.`,
    );
  return value;
}
export function parseIntake(value: unknown): IntakeSource {
  const s = object(value);
  const path = field(s, "path");
  const title = field(s, "title");
  const type = field(s, "type");
  const quality = field(s, "quality");
  const status = field(s, "status");
  if (
    type !== "document" &&
    type !== "qa" &&
    type !== "transcript" &&
    type !== "curated" &&
    type !== "metadata"
  )
    throw new ClecError("INVALID_PACKAGE", "Unknown source type.");
  if (
    status !== "ready" &&
    status !== "quarantined" &&
    status !== "unsupported" &&
    status !== "metadata_only"
  )
    throw new ClecError("INVALID_PACKAGE", "Unknown source status.");
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((p) => p === ".." || p === ".") ||
    path.includes("\\")
  )
    throw new ClecError(
      "INVALID_PACKAGE",
      "Source path must be workspace relative.",
    );
  const optional = (key: string): string | undefined => {
    const value = s[key];
    if (value === undefined) return undefined;
    if (
      typeof value !== "string" ||
      value.length > 4096 ||
      value.includes("\0")
    )
      throw new ClecError("INVALID_PACKAGE", `Invalid ${key}.`);
    return value;
  };
  const date = optional("date");
  const dateBasis = optional("dateBasis");
  const origin = optional("origin");
  if (date !== undefined && (!validDate(date) || !dateBasis))
    throw new ClecError(
      "INVALID_PACKAGE",
      "Dates require YYYY-MM-DD and dateBasis.",
    );
  return {
    path,
    title,
    type,
    quality,
    status,
    ...(date === undefined ? {} : { date }),
    ...(dateBasis === undefined ? {} : { dateBasis }),
    ...(origin === undefined ? {} : { origin }),
  };
}
export function parseSource(value: unknown): Source {
  const raw = object(value);
  const entry = parseIntake(value);
  const id = field(raw, "id");
  const version = field(raw, "version");
  const contentHash = field(raw, "contentHash");
  if (
    id !== hash(entry.path) ||
    !isHash(contentHash) ||
    version !== hash(JSON.stringify({ ...entry, contentHash }))
  )
    throw new ClecError("INVALID_PACKAGE", "Invalid source identity.");
  return {
    ...entry,
    id,
    version,
    contentHash,
    date: entry.date,
    dateBasis: entry.dateBasis,
  };
}
export function remoteUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ClecError("INVALID_URL", "Expected an absolute HTTP(S) URL.");
  }
  if (url.username || url.password || url.href.includes("#"))
    throw new ClecError(
      "INVALID_URL",
      "Credentials and URL fragments are unsupported.",
    );
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new ClecError("INVALID_URL", "Use HTTPS; HTTP is loopback only.");
  return url;
}
export function parseManifest(value: unknown): Manifest {
  const m = object(value);
  const counts = object(m.counts);
  if (
    m.formatRevision !== 1 ||
    m.artifact !== "corpus.sqlite" ||
    typeof m.sha256 !== "string" ||
    !isHash(m.sha256)
  )
    throw new ClecError("INVALID_PACKAGE", "Unsupported release manifest.");
  const artifactUrl =
    m.artifactUrl === undefined
      ? undefined
      : remoteUrl(field(m, "artifactUrl")).href;
  const packageInteger = (value: unknown, min: number, max: number): number => {
    try {
      return integer(value, min, max);
    } catch {
      throw new ClecError(
        "INVALID_PACKAGE",
        `Manifest integer must be in ${min}..${max}.`,
      );
    }
  };
  return {
    formatRevision: 1,
    artifact: "corpus.sqlite",
    ...(artifactUrl === undefined ? {} : { artifactUrl }),
    bytes: packageInteger(m.bytes, 1, MAX_ARTIFACT),
    sha256: m.sha256,
    counts: {
      sources: packageInteger(counts.sources, 1, 1_000_000),
      sections: packageInteger(counts.sections, 1, 10_000_000),
      inventory: packageInteger(counts.inventory, 1, 1_000_000),
    },
  };
}
export interface Reference {
  release: string;
  id: string;
}
export function reference(value: string): Reference {
  const parts = value.split(":");
  const release = parts[0];
  const id = parts[1];
  if (parts.length !== 2 || !release || !id || !isHash(release) || !isHash(id))
    throw new ClecError(
      "INVALID_REFERENCE",
      "Expected release-sha256:object-sha256.",
    );
  return { release, id };
}
