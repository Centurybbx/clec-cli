import {
  readFile,
  realpath,
  stat,
  mkdir,
  rm,
  rename,
  writeFile,
  statfs,
} from "node:fs/promises";
import {
  resolve,
  relative,
  isAbsolute,
  sep,
  extname,
  join,
  dirname,
  basename,
} from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import {
  ClecError,
  hash,
  object,
  parseIntake,
  remoteUrl,
  RESERVE,
  MAX_ARTIFACT,
  type Inventory,
  type Source,
  type Manifest,
} from "./contracts.js";
import { CURRENT_SCHEMA } from "./corpus-format.js";
import {
  extract,
  sourceMetadata,
} from "./source-extraction.js";
import { segment } from "./sections.js";
import { indexTokens } from "./lexical.js";

export async function build(options: {
  workspace: string;
  intake: string;
  output: string;
  artifactUrl?: string;
}): Promise<Manifest> {
  const ceiling = MAX_ARTIFACT;
  const artifactUrl =
    options.artifactUrl === undefined
      ? undefined
      : remoteUrl(options.artifactUrl).href;
  const workspace = await realpath(options.workspace);
  const output = resolve(options.output);
  const intakeStat = await stat(options.intake);
  if (intakeStat.size > 32 * 1024 ** 2)
    throw new ClecError("INVALID_MANIFEST", "Intake exceeds 32 MiB.");
  const intake = object(JSON.parse(await readFile(options.intake, "utf8")));
  if (
    intake.schemaVersion !== 1 ||
    !Array.isArray(intake.sources) ||
    intake.sources.length > 1_000_000
  )
    throw new ClecError(
      "INVALID_MANIFEST",
      "Expected intake schemaVersion 1 and sources.",
    );
  const entries = intake.sources
    .map((value) => {
      const raw = object(value);
      return parseIntake({
        ...raw,
        path:
          typeof raw.path === "string"
            ? raw.path.replaceAll("\\", "/")
            : raw.path,
      });
    })
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  const inventoryDetails = new Map<
    string,
    { status: string; reason: string }
  >();
  if (Array.isArray(intake.inventory))
    for (const item of intake.inventory) {
      const record = object(item);
      if (
        typeof record.path === "string" &&
        typeof record.status === "string" &&
        typeof record.reason === "string"
      )
        inventoryDetails.set(record.path, {
          status: record.status,
          reason: record.reason,
        });
    }
  if (new Set(entries.map((e) => e.path)).size !== entries.length)
    throw new ClecError("INVALID_MANIFEST", "Duplicate intake path.");
  await mkdir(dirname(output), { recursive: true });
  try {
    await stat(output);
    throw new ClecError(
      "OUTPUT_EXISTS",
      "Publisher output must be a new release directory.",
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const space = await statfs(dirname(output));
  if (space.bavail * space.bsize < RESERVE + ceiling)
    throw new ClecError(
      "INSUFFICIENT_SPACE",
      "Publisher requires artifact ceiling plus 5 GiB reserve.",
    );
  const staging = join(dirname(output), `.${basename(output)}.building`);
  await mkdir(staging);
  const dbPath = join(staging, "corpus.sqlite");
  let db: DatabaseSync | undefined;
  const counts = { sources: 0, sections: 0, inventory: 0 };
  try {
    db = new DatabaseSync(dbPath);
    db.exec(CURRENT_SCHEMA);
    const addSource = db.prepare("INSERT INTO sources VALUES(?,?,?,?)");
    const addSection = db.prepare("INSERT INTO sections VALUES(?,?,?,?,?,?)");
    const addSearch = db.prepare(
      "INSERT INTO search(rowid,title,tokens) VALUES(?,?,?)",
    );
    const addInventory = db.prepare("INSERT INTO inventory VALUES(?,?,?,?)");
    for (const entry of entries) {
      let inventory: Inventory;
      if (
        entry.status !== "ready" ||
        entry.type === "metadata" ||
        /(^|\/)quarantine(\/|$)/i.test(entry.path)
      )
        inventory = {
          path: entry.path,
          status: entry.status === "ready" ? "excluded" : entry.status,
          reason: "Excluded by source provenance/status.",
        };
      else if (
        ![
          ".md",
          ".txt",
          ".srt", ".str", ".vtt",
        ].includes(extname(entry.path).toLowerCase())
      )
        inventory = {
          path: entry.path,
          status: "unsupported",
          reason: "Unsupported evidence extension; upstream text extraction required.",
        };
      else {
        let bytes: Buffer | undefined;
        try {
          const target = await realpath(resolve(workspace, entry.path));
          const rel = relative(workspace, target);
          if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
            throw new ClecError(
              "UNSAFE_PATH",
              "Source resolved outside workspace.",
            );
          if ((await stat(target)).size > 100_000_000)
            throw new ClecError(
              "SOURCE_TOO_LARGE",
              "Source exceeds intake size limit.",
            );
          bytes = await readFile(target);
        } catch (error) {
          if (error instanceof ClecError) throw error;
        }
        if (!bytes)
          inventory = {
            path: entry.path,
            status: "unavailable",
            reason: "Source could not be read.",
          };
        else {
          const subtitle = [".srt", ".str", ".vtt"].includes(
            extname(entry.path).toLowerCase(),
          );
          let extraction: ReturnType<typeof extract> | undefined;
          try {
            extraction = extract(bytes, subtitle);
          } catch {}
          const text = extraction?.text;
          const contentHash =
            text === undefined ? hash(bytes) : hash(Buffer.from(text, "utf8"));
          if (text === undefined)
            inventory = {
              path: entry.path,
              status: "unsupported",
              reason: "Invalid UTF-8; extraction required.",
              contentHash,
            };
          else if (subtitle && !extraction?.cues.length)
            inventory = {
              path: entry.path,
              status: "unsupported",
              reason: "No usable subtitle cues; original not admitted.",
              contentHash,
            };
          else if (!text.trim() || text.includes("\0"))
            inventory = {
              path: entry.path,
              status: text.includes("\0") ? "quarantined" : "empty",
              reason: "Empty text or binary NUL content.",
              contentHash,
            };
          else {
            const source: Source = {
              ...entry,
              id: hash(entry.path),
              version: hash(JSON.stringify({ ...entry, contentHash })),
              contentHash,
              date: entry.date,
              dateBasis: entry.dateBasis,
            };
            db.exec("BEGIN");
            try {
              addSource.run(
                source.id,
                source.version,
                JSON.stringify(source),
                text,
              );
              if (extraction) {
                db.prepare("INSERT INTO source_metadata VALUES(?,?)").run(
                  source.id,
                  JSON.stringify(sourceMetadata(source, extraction)),
                );
                for (const cue of extraction.cues)
                  db.prepare("INSERT INTO cues VALUES(?,?,?)").run(
                    source.id,
                    cue.ordinal,
                    JSON.stringify(cue),
                  );
              }
              for (const s of segment(source, text)) {
                const result = addSection.run(
                  s.id,
                  s.sourceId,
                  s.order,
                  s.start,
                  s.end,
                  s.boundary,
                );
                addSearch.run(
                  result.lastInsertRowid,
                  indexTokens(source.title),
                  indexTokens(text.slice(s.start, s.end)),
                );
                counts.sections++;
              }
              db.exec("COMMIT");
            } catch (error) {
              db.exec("ROLLBACK");
              throw error;
            }
            counts.sources++;
            inventory = {
              path: entry.path,
              status: "indexed",
              reason: "Explicitly admitted; quality label retained.",
              contentHash,
            };
          }
        }
      }
      const detail = inventoryDetails.get(entry.path);
      if (
        entry.status !== "ready" &&
        detail &&
        [
          "quarantined",
          "unsupported",
          "metadata_only",
          "empty",
          "excluded",
          "missing",
          "error",
        ].includes(detail.status)
      )
        inventory = { ...inventory, ...detail };
      addInventory.run(
        inventory.path,
        inventory.status,
        inventory.reason,
        inventory.contentHash ?? null,
      );
      counts.inventory++;
      if ((await stat(dbPath)).size > ceiling)
        throw new ClecError(
          "PACKAGE_TOO_LARGE",
          "Corpus exceeds artifact ceiling.",
        );
    }
    if (!counts.sources)
      throw new ClecError("EMPTY_CORPUS", "No usable evidence.");
    db.exec("INSERT INTO search(search) VALUES('optimize')");
  } catch (error) {
    db?.close();
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  db.close();
  try {
    const bytes = (await stat(dbPath)).size;
    if (bytes > ceiling)
      throw new ClecError(
        "PACKAGE_TOO_LARGE",
        "Corpus exceeds artifact ceiling.",
      );
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(dbPath)) digest.update(chunk);
    const manifest: Manifest = {
      formatRevision: 3,
      artifact: "corpus.sqlite",
      ...(artifactUrl === undefined ? {} : { artifactUrl }),
      bytes,
      sha256: digest.digest("hex"),
      counts,
    };
    await writeFile(
      join(staging, "manifest.json"),
      JSON.stringify(manifest) + "\n",
      { flag: "wx" },
    );
    await rename(staging, output);
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
