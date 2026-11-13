#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { readFile } from "node:fs/promises";
import type { Writable } from "node:stream";
import { ClecError, reference } from "./contracts.js";
import {
  help,
  isCommand,
  parseInvocation,
  requestedFormat,
  type Invocation,
  type CommandName,
} from "./commands.js";
import { failure, render, type CommandResult } from "./output.js";

async function stdinRefs(): Promise<string[]> {
  if (process.stdin.isTTY)
    throw new ClecError(
      "INVALID_ARGUMENT",
      "--stdin requires piped newline-delimited references.",
    );
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > 64 * 1024) {
      process.stdin.destroy();
      throw new ClecError("INVALID_ARGUMENT", "--stdin exceeds 64 KiB.");
    }
    chunks.push(buffer);
  }
  let input: string;
  try {
    input = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new ClecError(
      "INVALID_ARGUMENT",
      "--stdin must contain valid UTF-8 references.",
    );
  }
  const refs = input
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!refs.length || refs.length > 50)
    throw new ClecError(
      "INVALID_ARGUMENT",
      "--stdin needs 1..50 nonblank references.",
    );
  return refs;
}
function checkedRefs(refs: string[]): ReturnType<typeof reference>[] {
  let release: string | undefined;
  return refs.map((ref, inputIndex) => {
    try {
      const parsed = reference(ref);
      if (release && parsed.release !== release)
        throw new ClecError(
          "INVALID_REFERENCE",
          "A read batch must use one release.",
        );
      release = parsed.release;
      return parsed;
    } catch (error) {
      if (error instanceof ClecError)
        throw new ClecError(error.code, error.message, { inputIndex });
      throw error;
    }
  });
}
async function execute(invocation: Invocation): Promise<CommandResult> {
  const command = invocation.command;
  if (command.kind === "help")
    return { command: "help", data: help(command.topic) };
  if (command.kind === "version") {
    const metadata: unknown = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    if (
      !metadata ||
      typeof metadata !== "object" ||
      !("version" in metadata) ||
      typeof metadata.version !== "string"
    )
      throw new ClecError(
        "INVALID_PACKAGE",
        "Installed package version is missing.",
      );
    return { command: "version", data: { version: metadata.version } };
  }
  const { sync, status, openCurrent } = await import("./releases.js");
  if (command.kind === "sync")
    return {
      command: "sync",
      data: await sync(invocation.directory, command.manifest),
    };
  if (command.kind === "status")
    return { command: "status", data: await status(invocation.directory) };
  const refs =
    command.kind === "read"
      ? command.input.kind === "stdin"
        ? await stdinRefs()
        : command.input.refs
      : [];
  const parsedRefs = checkedRefs(refs);
  const expected =
    command.kind === "source"
      ? command.ref.release
      : command.kind === "read"
        ? parsedRefs[0]?.release
        : command.release;
  const corpus = await openCurrent(invocation.directory, expected);
  try {
    switch (command.kind) {
      case "search":
        return {
          command: "search",
          data: corpus.search(command.query, command.options),
        };
      case "sources":
        return {
          command: "sources",
          data: corpus.sources(command.query, command.options),
        };
      case "source":
        return {
          command: "source",
          data: corpus.source(
            command.ref.id,
            command.options.offset,
            command.options.limit,
          ),
        };
      case "read":
        return {
          command: "read",
          data: corpus.readMany(parsedRefs, command.context),
        };
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  } finally {
    corpus.close();
  }
}
const isPipeClosed = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "EPIPE";
let closed = false;
process.stdout.on("error", (error) => {
  if (isPipeClosed(error)) {
    closed = true;
    process.exitCode = 0;
  }
});
process.stderr.on("error", (error) => {
  if (isPipeClosed(error)) {
    closed = true;
    process.exitCode = 0;
  }
});
process.once("SIGINT", () => {
  process.exit(130);
});
async function write(stream: Writable, value: string): Promise<void> {
  if (closed) return;
  await new Promise<void>((resolve, reject) => {
    stream.write(value, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
let commandName: CommandName | null = null;
const args = process.argv.slice(2);
let format = requestedFormat(args);
try {
  const invocation = parseInvocation(args);
  format = invocation.format;
  commandName = invocation.command.kind;
  await write(process.stdout, render(await execute(invocation), format));
} catch (error) {
  if (isPipeClosed(error) || closed) process.exitCode = 0;
  else {
    if (commandName === null) {
      const raw = args.find((arg) => isCommand(arg));
      if (raw && isCommand(raw)) commandName = raw;
    }
    const result = failure(error, commandName, format);
    process.exitCode = result.exit;
    try {
      await write(process.stderr, result.text);
    } catch (writeError) {
      if (isPipeClosed(writeError)) process.exitCode = 0;
    }
  }
}
