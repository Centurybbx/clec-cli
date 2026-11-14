import { ClecError, type ErrorCode } from "./contracts.js";
import type { Corpus } from "./corpus.js";
import type { CommandName, Format } from "./commands.js";
import { help } from "./commands.js";
import type {
  Evidence,
  Page,
  ReadResult,
  SearchPage,
  SourcePage,
  SourceSections,
} from "./corpus.js";
import type { StatusResult, SyncResult } from "./releases.js";
export type CommandResult =
  | { command: "guide"; data: { text: string } }
  | { command: "coverage"; data: ReturnType<Corpus["coverage"]> }
  | { command: "find"; data: ReturnType<Corpus["find"]> }
  | { command: "read-range"; data: ReturnType<Corpus["readRange"]> }
  | { command: "help"; data: ReturnType<typeof help> }
  | { command: "version"; data: { version: string } }
  | { command: "sync"; data: SyncResult }
  | { command: "status"; data: StatusResult }
  | { command: "search"; data: SearchPage }
  | { command: "sources"; data: SourcePage }
  | { command: "source"; data: SourceSections }
  | { command: "read"; data: ReadResult };
const policies: Record<ErrorCode, { exit: number; remedy: string }> = {
  INVALID_ARGUMENT: {
    exit: 2,
    remedy: "Run clec help COMMAND for accepted arguments and bounds.",
  },
  INVALID_QUERY: {
    exit: 2,
    remedy:
      "Use one quoted query of 1..512 UTF-16 units and at most 64 lexical terms.",
  },
  INVALID_REFERENCE: {
    exit: 2,
    remedy:
      "Copy a full release:object reference from clec search, sources or source.",
  },
  INVALID_URL: {
    exit: 2,
    remedy:
      "Use a local manifest path or HTTPS URL without credentials or fragments; HTTP is loopback only.",
  },
  NO_DATA: {
    exit: 3,
    remedy:
      "Run clec sync --manifest PATH_OR_HTTPS_URL; no default public corpus origin is supplied.",
  },
  VERSION_UNAVAILABLE: {
    exit: 3,
    remedy:
      "Run clec status, then repeat discovery/search against the active release; replace stale references and restart paging.",
  },
  EVIDENCE_NOT_FOUND: {
    exit: 3,
    remedy:
      "Discover the source with clec sources, then use clec source SOURCE_REF to obtain section refs.",
  },
  BUSY: { exit: 4, remedy: "Wait for the active sync to finish, then retry." },
  SYNC_LOCKED: {
    exit: 4,
    remedy:
      "Wait for the sync owner to finish. Only recover a lock after confirming its owner is gone.",
  },
  CLEANUP_BLOCKED: {
    exit: 4,
    remedy:
      "Close corpus readers, check data-directory permissions and retry sync.",
  },
  INSUFFICIENT_SPACE: {
    exit: 4,
    remedy:
      "Provide room for the incoming corpus plus 5 GiB reserve, then retry sync.",
  },
  INVALID_DATA_DIR: {
    exit: 4,
    remedy: "Choose a writable directory with --data-dir PATH.",
  },
  TRANSFER_FAILED: {
    exit: 4,
    remedy:
      "Check the manifest/artifact location and network connection, then retry sync.",
  },
  TRANSFER_TOO_LARGE: {
    exit: 4,
    remedy:
      "Obtain a matching, valid manifest and artifact from the publisher.",
  },
  CONFIG_SAVE_FAILED: {
    exit: 4,
    remedy:
      "The reported release is already active. Fix data-directory permissions and repeat sync --manifest LOCATION to save the origin.",
  },
  IO_ERROR: {
    exit: 4,
    remedy:
      "Check file paths, data-directory permissions, free space and network availability, then retry.",
  },
  INVALID_PACKAGE: {
    exit: 5,
    remedy:
      "Obtain a valid release from the publisher and run clec sync --manifest LOCATION.",
  },
  INTEGRITY_MISMATCH: {
    exit: 5,
    remedy:
      "Run clec sync --manifest LOCATION to repair from the verified publisher artifact.",
  },
  EMPTY_CORPUS: {
    exit: 5,
    remedy: "Provide at least one admitted source when publishing.",
  },
  INVALID_MANIFEST: {
    exit: 5,
    remedy: "Check the publisher intake manifest and rebuild the release.",
  },
  OUTPUT_EXISTS: {
    exit: 4,
    remedy: "Choose a new output directory for the publisher.",
  },
  PACKAGE_TOO_LARGE: {
    exit: 5,
    remedy: "Reduce the published corpus to its admitted size bound.",
  },
  SOURCE_TOO_LARGE: {
    exit: 5,
    remedy: "Reduce or split the oversized intake source before publishing.",
  },
  UNSAFE_PATH: {
    exit: 5,
    remedy: "Use admitted workspace-relative source paths without traversal.",
  },
  INTERNAL_ERROR: {
    exit: 1,
    remedy:
      "Retry; if it persists, report the command, CLI version and this message to the maintainer.",
  },
};
export function failure(
  error: unknown,
  command: CommandName | null,
  format: Format,
): { text: string; exit: number } {
  const known = error instanceof ClecError;
  const filesystemCodes = new Set([
    "EACCES",
    "EPERM",
    "ENOENT",
    "ENOTDIR",
    "EISDIR",
    "EEXIST",
    "ENOSPC",
    "EROFS",
    "EMFILE",
    "ENFILE",
    "EIO",
    "EBUSY",
    "ETXTBSY",
    "ENAMETOOLONG",
  ]);
  const system =
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    filesystemCodes.has(error.code);
  const corrupt =
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_SQLITE_ERROR" &&
    "errcode" in error &&
    (error.errcode === 11 || error.errcode === 26);
  const code = known
    ? error.code
    : corrupt
      ? "INVALID_PACKAGE"
      : system
        ? "IO_ERROR"
        : "INTERNAL_ERROR";
  const policy = policies[code];
  const detail = {
    code,
    message:
      error instanceof Error ? error.message : "Unexpected operation failure.",
    remedy: policy.remedy,
    ...(known ? error.details : {}),
  };
  return {
    exit: policy.exit,
    text:
      format === "json"
        ? JSON.stringify({
            schemaVersion: 1,
            ok: false,
            command,
            error: detail,
          }) + "\n"
        : textSafe(
            `${detail.code}: ${detail.message}\nRemedy: ${detail.remedy}${known && error.details.inputIndex !== undefined ? `\nInput index: ${error.details.inputIndex} (zero-based)` : ""}\n`,
          ),
  };
}
const textSafe = (value: string): string =>
  value.replace(
    /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
const paging = (page: Page): string =>
  `Page offset ${page.offset}, limit ${page.limit}; nextOffset: ${page.nextOffset ?? "none"}`;
function evidence(item: Evidence): string {
  return [
    `${item.source.title}\n${item.source.path}`,
    `Ref: ${item.ref}`,
    `Source: ${item.sourceRef}`,
    `Date: ${item.source.date ?? "unknown"} (${item.source.dateBasis ?? "unspecified"}); type: ${item.source.type}; quality: ${item.source.quality}`,
    `UTF-16 [${item.section.start}, ${item.section.end}); content SHA-256: ${item.source.contentHash}`,
    item.text,
    ...item.context.map(
      (context) =>
        `Context ${context.ref} UTF-16 [${context.section.start}, ${context.section.end}):\n${context.text}`,
    ),
    `Previous: ${item.previous ?? "none"}\nNext: ${item.next ?? "none"}`,
    ...item.warnings.map((warning) => `Note: ${warning}`),
  ].join("\n");
}
export function render(result: CommandResult, format: Format): string {
  if (format === "json")
    return (
      JSON.stringify({
        schemaVersion: 1,
        ok: true,
        command: result.command,
        data: result.data,
      }) + "\n"
    );
  return textSafe(renderText(result));
}
function renderText(result: CommandResult): string {
  switch (result.command) {
    case "guide":
      return result.data.text + "\n";
    case "coverage":
    case "find":
    case "read-range":
      return JSON.stringify(result.data, null, 2) + "\n";
    case "help":
      return (
        [
          result.data.usage,
          ...result.data.commands.map(
            (command) =>
              `${command.name}: clec ${command.usage}\n  ${command.summary}${command.options.length ? "\n  " + command.options.join("\n  ") : ""}`,
          ),
          "Global options (before or after command):\n  " +
            result.data.globals.join("\n  "),
          result.data.paging,
          result.data.runtime,
          result.data.migration,
        ].join("\n\n") + "\n"
      );
    case "version":
      return `${result.data.version}\n`;
    case "status":
      return (
        [
          `Ready: ${result.data.ready}`,
          `Data directory: ${result.data.directory}`,
          `Manifest: ${result.data.manifest ?? "not configured"}`,
          `Release: ${result.data.release ?? "none"}`,
          `Managed bytes: ${result.data.managedBytes}`,
          ...(result.data.counts
            ? [
                `Sources: ${result.data.counts.sources}; sections: ${result.data.counts.sections}; inventory: ${result.data.counts.inventory}`,
              ]
            : []),
          `Setup/sync (POSIX shell): ${result.data.setupCommand}`,
        ].join("\n") + "\n"
      );
    case "sync":
      return (
        [
          `Release: ${result.data.release}`,
          `Manifest: ${result.data.manifest}`,
          `Sources: ${result.data.counts.sources}; sections: ${result.data.counts.sections}`,
          `Managed bytes: ${result.data.managedBytes}`,
          `Reused: ${result.data.reused ?? false}; repaired: ${result.data.repaired ?? false}; cleanup pending: ${result.data.cleanupPending ?? false}`,
        ].join("\n") + "\n"
      );
    case "read":
      return `Release: ${result.data.release}\n\n${result.data.items.map(evidence).join("\n\n")}\n`;
    case "search":
      return (
        [
          `Release: ${result.data.release}`,
          `Query: ${result.data.query}; match: ${result.data.match}; terms: ${result.data.terms.join(", ")}`,
          `Filters: ${JSON.stringify(result.data.filters)}`,
          ...result.data.hits.map(
            (hit) =>
              `${hit.source.title}\n${hit.source.path}\nRef: ${hit.ref}\nSource: ${hit.sourceRef}\nDate: ${hit.source.date ?? "unknown"} (${hit.source.dateBasis ?? "unspecified"}); quality: ${hit.source.quality}; score: ${hit.score}\n${hit.previewKind === "match" ? "Match preview" : "Leading preview"}: ${hit.preview}\n${hit.warnings.map((w) => `Note: ${w}`).join("\n")}`,
          ),
          ...(result.data.hits.length
            ? []
            : [
                "No hits. Try different terms or clec sources; zero hits do not establish corpus absence.",
              ]),
          paging(result.data.page),
        ].join("\n\n") + "\n"
      );
    case "sources":
      return (
        [
          `Release: ${result.data.release}`,
          `Query: ${result.data.query}; terms: ${result.data.terms.join(", ")}`,
          ...result.data.items.map(
            (source) =>
              `${source.title}\n${source.path}\nSource: ${source.sourceRef}\nType: ${source.type}; date: ${source.date ?? "unknown"} (${source.dateBasis ?? "unspecified"}); quality: ${source.quality}; sections: ${source.sectionCount}`,
          ),
          ...(result.data.items.length
            ? []
            : [
                "No sources matched. Empty discovery does not establish corpus absence.",
              ]),
          paging(result.data.page),
        ].join("\n\n") + "\n"
      );
    case "source":
      return (
        [
          `Release: ${result.data.release}`,
          `${result.data.source.title}\n${result.data.source.path}\nSource: ${result.data.ref}`,
          ...result.data.source.warnings.map((w) => `Note: ${w}`),
          ...result.data.sections.map(
            (section) =>
              `Ref: ${section.ref}\nUTF-16 [${section.start}, ${section.end})\nLeading preview: ${section.preview}`,
          ),
          paging(result.data.page),
        ].join("\n\n") + "\n"
      );
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}
