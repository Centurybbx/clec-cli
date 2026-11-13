import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import {
  ClecError,
  integer,
  isHash,
  reference,
  validDate,
} from "./contracts.js";
export type Format = "text" | "json";
export const descriptors = {
  help: {
    usage: "help [COMMAND]",
    summary: "Describe commands and options.",
    options: [],
  },
  version: {
    usage: "version",
    summary: "Print the installed package version.",
    options: [],
  },
  sync: {
    usage: "sync [--manifest LOCATION]",
    summary:
      "Verify and activate a release; remember a successful origin for repeat sync.",
    options: ["manifest"],
  },
  status: {
    usage: "status",
    summary: "Show setup, configured origin, active release and storage.",
    options: [],
  },
  search: {
    usage: "search QUERY [OPTIONS]",
    summary:
      "Search evidence. Quote QUERY as one argument. any uses token OR; all is token conjunction, not phrase matching. Date filters exclude unknown dates.",
    options: [
      "match",
      "limit",
      "offset",
      "per-source",
      "source",
      "date-from",
      "date-to",
      "release",
    ],
  },
  sources: {
    usage: "sources [QUERY] [OPTIONS]",
    summary:
      "Discover titles and full paths; all normalized whitespace terms must occur literally. Editions remain separate.",
    options: ["limit", "offset", "release"],
  },
  source: {
    usage: "source REF [OPTIONS]",
    summary:
      "List bounded section previews for a release-qualified source ref.",
    options: ["limit", "offset"],
  },
  read: {
    usage: "read REF... [--context N] | read --stdin [--context N]",
    summary:
      "Read exact sections atomically, preserving order and duplicates. stdin: newline refs, at most 50 refs / 64 KiB. Context sections carry separate refs and spans.",
    options: ["stdin", "context"],
  },
} satisfies Record<
  string,
  { usage: string; summary: string; options: string[] }
>;
export type CommandName = keyof typeof descriptors;
export const isCommand = (value: string): value is CommandName =>
  Object.hasOwn(descriptors, value);
import type { Paging, SearchOptions } from "./corpus.js";
type Command =
  | { kind: "help"; topic?: CommandName }
  | { kind: "version" }
  | { kind: "status" }
  | { kind: "sync"; manifest?: string }
  | { kind: "search"; query: string; options: SearchOptions; release?: string }
  | { kind: "sources"; query: string; options: Paging; release?: string }
  | { kind: "source"; ref: ReturnType<typeof reference>; options: Paging }
  | {
      kind: "read";
      input: { kind: "stdin" } | { kind: "refs"; refs: string[] };
      context: number;
    };
export interface Invocation {
  command: Command;
  format: Format;
  directory: string;
}
const optionHelp: Record<string, string> = {
  manifest: "PATH|URL (no default public manifest; saved after success)",
  match: "any|all (default any)",
  limit: "1..50 (search 8; sources/source 20)",
  offset: "0..10000000 (default 0)",
  "per-source": "1..50 (default 2, applied before paging)",
  source: "source ID or full source ref",
  "date-from": "YYYY-MM-DD (inclusive)",
  "date-to": "YYYY-MM-DD (inclusive)",
  release: "expected active SHA-256; repeat when paging",
  context: "0..2 neighboring sections per side (default 1)",
  stdin: "read newline refs from noninteractive stdin",
};
export function help(topic?: CommandName) {
  return {
    usage: topic
      ? `clec ${descriptors[topic].usage}`
      : "clec COMMAND [OPTIONS]",
    commands: (topic
      ? [topic]
      : Object.keys(descriptors).filter(isCommand)
    ).map((name) => ({
      name,
      ...descriptors[name],
      options: descriptors[name].options.map(
        (option) => `--${option} ${optionHelp[option] ?? ""}`,
      ),
    })),
    globals: [
      "--data-dir PATH (or CLEC_DATA_DIR)",
      "--format text|json (default text, also in pipes)",
      "--help, -h",
      "--version",
      "-- ends options",
    ],
    paging:
      "Repeat identical query/options and the returned --release with page.nextOffset. Empty results do not establish corpus absence.",
    runtime: "Node >=22.19.0",
    migration:
      "0.2: explicit --format json uses schemaVersion 1 and data; read always returns data.items.",
  };
}
export function requestedFormat(argv: string[]): Format {
  const end = argv.indexOf("--");
  const options = end < 0 ? argv : argv.slice(0, end);
  return options.some(
    (v, i) =>
      v === "--format=json" || (v === "--format" && options[i + 1] === "json"),
  )
    ? "json"
    : "text";
}
export function parseInvocation(argv: string[]): Invocation {
  const options: Record<
    string,
    { type: "string" | "boolean"; short?: string }
  > = {
    "data-dir": { type: "string" },
    format: { type: "string" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean" },
  };
  for (const descriptor of Object.values(descriptors))
    for (const name of descriptor.options)
      options[name] = { type: name === "stdin" ? "boolean" : "string" };
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    throw new ClecError(
      "INVALID_ARGUMENT",
      error instanceof Error ? error.message : "Invalid options.",
    );
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens ?? [])
    if (token.kind === "option") {
      if (seen.has(token.name))
        throw new ClecError("INVALID_ARGUMENT", `Duplicate --${token.name}.`);
      seen.add(token.name);
    }
  const values = parsed.values;
  const string = (key: string): string | undefined => {
    const value = values[key];
    return typeof value === "string" ? value : undefined;
  };
  const format = string("format") ?? "text";
  if (format !== "text" && format !== "json")
    throw new ClecError("INVALID_ARGUMENT", "--format must be text or json.");
  const directory = resolve(
    string("data-dir") ??
      process.env.CLEC_DATA_DIR ??
      join(homedir(), ".local", "share", "clec"),
  );
  const [raw, ...args] = parsed.positionals;
  if (raw !== undefined && !isCommand(raw))
    throw new ClecError(
      "INVALID_ARGUMENT",
      `Unknown command ${raw}. Run clec help.`,
    );
  const name = raw ?? "help";
  for (const key of seen)
    if (
      !["data-dir", "format", "help", "version"].includes(key) &&
      !descriptors[name].options.some((option) => option === key)
    )
      throw new ClecError(
        "INVALID_ARGUMENT",
        `--${key} is not supported by ${name}.`,
      );
  const finish = (command: Command): Invocation => ({
    command,
    format,
    directory,
  });
  if (values.help)
    return finish(raw ? { kind: "help", topic: raw } : { kind: "help" });
  if (values.version) {
    if (raw || args.length)
      throw new ClecError(
        "INVALID_ARGUMENT",
        "--version must be used without a command.",
      );
    return finish({ kind: "version" });
  }
  const count = (min: number, max = min): void => {
    if (args.length < min || args.length > max)
      throw new ClecError(
        "INVALID_ARGUMENT",
        `Expected clec ${descriptors[name].usage}.`,
      );
  };
  const numeric = (
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const raw = string(key);
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw))
      throw new ClecError(
        "INVALID_ARGUMENT",
        `--${key} must be an integer in ${min}..${max}.`,
      );
    return integer(Number(raw), min, max);
  };
  const paging = (fallback: number): Paging => ({
    limit: numeric("limit", fallback, 1, 50),
    offset: numeric("offset", 0, 0, 10_000_000),
  });
  const release = string("release");
  if (release !== undefined && !isHash(release))
    throw new ClecError("INVALID_ARGUMENT", "--release requires a SHA-256.");
  switch (name) {
    case "help": {
      count(0, 1);
      const topic = args[0];
      if (topic !== undefined && !isCommand(topic))
        throw new ClecError("INVALID_ARGUMENT", `Unknown help topic ${topic}.`);
      return finish(topic ? { kind: "help", topic } : { kind: "help" });
    }
    case "version":
    case "status":
      count(0);
      return finish({ kind: name });
    case "sync": {
      count(0);
      const manifest = string("manifest");
      return finish({
        kind: "sync",
        ...(manifest === undefined ? {} : { manifest }),
      });
    }
    case "sources":
      count(0, 1);
      return finish({
        kind: "sources",
        query: args[0] ?? "",
        options: paging(20),
        ...(release === undefined ? {} : { release }),
      });
    case "source":
      count(1);
      return finish({
        kind: "source",
        ref: reference(args[0] ?? ""),
        options: paging(20),
      });
    case "read": {
      const stdin = values.stdin === true;
      count(stdin ? 0 : 1, stdin ? 0 : 50);
      return finish({
        kind: "read",
        input: stdin ? { kind: "stdin" } : { kind: "refs", refs: args },
        context: numeric("context", 1, 0, 2),
      });
    }
    case "search": {
      count(1);
      const match = string("match") ?? "any";
      if (match !== "any" && match !== "all")
        throw new ClecError("INVALID_ARGUMENT", "--match must be any or all.");
      let source = string("source");
      let pinned = release;
      if (source !== undefined) {
        if (source.includes(":")) {
          const ref = reference(source);
          if (pinned && pinned !== ref.release)
            throw new ClecError(
              "INVALID_ARGUMENT",
              "--source and --release disagree.",
            );
          pinned = ref.release;
          source = ref.id;
        } else if (!isHash(source))
          throw new ClecError(
            "INVALID_ARGUMENT",
            "--source requires a source ID or full source ref.",
          );
      }
      const dateFrom = string("date-from");
      const dateTo = string("date-to");
      if (
        (dateFrom !== undefined && !validDate(dateFrom)) ||
        (dateTo !== undefined && !validDate(dateTo)) ||
        (dateFrom && dateTo && dateFrom > dateTo)
      )
        throw new ClecError(
          "INVALID_ARGUMENT",
          "Date filters require an ordered YYYY-MM-DD range.",
        );
      return finish({
        kind: "search",
        query: args[0] ?? "",
        options: {
          ...paging(8),
          match,
          perSource: numeric("per-source", 2, 1, 50),
          ...(source === undefined ? {} : { source }),
          ...(dateFrom === undefined ? {} : { dateFrom }),
          ...(dateTo === undefined ? {} : { dateTo }),
        },
        ...(pinned === undefined ? {} : { release: pinned }),
      });
    }
    default: {
      const exhaustive: never = name;
      return exhaustive;
    }
  }
}
