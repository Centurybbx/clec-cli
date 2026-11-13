import { readFile, realpath, stat, mkdir, rm, rename, writeFile, statfs } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, extname, join, dirname, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { ClecError, hash, object, parseIntake, remoteUrl, RESERVE, MAX_ARTIFACT, type Inventory, type Source, type Manifest } from './contracts.js';
import { SCHEMA } from './corpus.js';
import { segment } from './sections.js';
import { indexTokens } from './lexical.js';

async function build(options: { workspace: string; intake: string; output: string; artifactUrl?: string }): Promise<Manifest> {
  const artifactUrl = options.artifactUrl === undefined ? undefined : remoteUrl(options.artifactUrl).href;
  const workspace = await realpath(options.workspace); const output = resolve(options.output);
  const intakeStat = await stat(options.intake);
  if (intakeStat.size > 32 * 1024 ** 2) throw new ClecError('INVALID_MANIFEST', 'Intake exceeds 32 MiB.');
  const intake = object(JSON.parse(await readFile(options.intake, 'utf8')));
  if (intake.schemaVersion !== 1 || !Array.isArray(intake.sources) || intake.sources.length > 1_000_000) throw new ClecError('INVALID_MANIFEST', 'Expected intake schemaVersion 1 and sources.');
  const entries = intake.sources.map(value => {
    const raw = object(value);
    return parseIntake({ ...raw, path: typeof raw.path === 'string' ? raw.path.replaceAll('\\', '/') : raw.path });
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (new Set(entries.map(e => e.path)).size !== entries.length) throw new ClecError('INVALID_MANIFEST', 'Duplicate intake path.');
  await mkdir(dirname(output), { recursive: true });
  try { await stat(output); throw new ClecError('OUTPUT_EXISTS', 'Publisher output must be a new release directory.'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const space = await statfs(dirname(output)); if (space.bavail * space.bsize < RESERVE + MAX_ARTIFACT) throw new ClecError('INSUFFICIENT_SPACE', 'Publisher requires artifact ceiling plus 5 GiB reserve.');
  const staging = join(dirname(output), `.${basename(output)}.building`); await mkdir(staging);
  const dbPath = join(staging, 'corpus.sqlite');
  let db: DatabaseSync | undefined;
  const counts = { sources: 0, sections: 0, inventory: 0 };
  try {
    db = new DatabaseSync(dbPath);
    db.exec(SCHEMA);
    const addSource = db.prepare('INSERT INTO sources VALUES(?,?,?,?)');
    const addSection = db.prepare('INSERT INTO sections VALUES(?,?,?,?,?,?)');
    const addSearch = db.prepare('INSERT INTO search(rowid,title,tokens) VALUES(?,?,?)');
    const addInventory = db.prepare('INSERT INTO inventory VALUES(?,?,?,?)');
    for (const entry of entries) {
      let inventory: Inventory;
      if (entry.status !== 'ready' || entry.type === 'metadata' || /(^|\/)quarantine(\/|$)/i.test(entry.path)) inventory = { path: entry.path, status: entry.status === 'ready' ? 'excluded' : entry.status, reason: 'Excluded by source provenance/status.' };
      else if (!['.md', '.txt'].includes(extname(entry.path).toLowerCase())) inventory = { path: entry.path, status: 'unsupported', reason: 'This slice admits UTF-8 .md/.txt only; original retained.' };
      else {
        let bytes: Buffer | undefined;
        try {
          const target = await realpath(resolve(workspace, entry.path)); const rel = relative(workspace, target);
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ClecError('UNSAFE_PATH', 'Source resolved outside workspace.');
          if ((await stat(target)).size > 100_000_000) throw new ClecError('SOURCE_TOO_LARGE', 'Source exceeds intake size limit.');
          bytes = await readFile(target);
        } catch (error) { if (error instanceof ClecError) throw error; }
        if (!bytes) inventory = { path: entry.path, status: 'unavailable', reason: 'Source could not be read.' };
        else {
          const contentHash = hash(bytes); let text: string | undefined;
          try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch {}
          if (text === undefined) inventory = { path: entry.path, status: 'unsupported', reason: 'Invalid UTF-8; extraction required.', contentHash };
          else if (!text.trim() || text.includes('\0')) inventory = { path: entry.path, status: text.includes('\0') ? 'quarantined' : 'empty', reason: 'Empty text or binary NUL content.', contentHash };
          else {
            const source: Source = { ...entry, id: hash(entry.path), version: hash(JSON.stringify({ ...entry, contentHash })), contentHash, date: entry.date, dateBasis: entry.dateBasis };
            db.exec('BEGIN');
            try {
              addSource.run(source.id, source.version, JSON.stringify(source), text);
              for (const s of segment(source, text)) {
                const result = addSection.run(s.id, s.sourceId, s.order, s.start, s.end, s.boundary);
                addSearch.run(result.lastInsertRowid, indexTokens(source.title), indexTokens(text.slice(s.start, s.end))); counts.sections++;
              }
              db.exec('COMMIT');
            } catch (error) { db.exec('ROLLBACK'); throw error; }
            counts.sources++; inventory = { path: entry.path, status: 'indexed', reason: 'Explicitly admitted; quality label retained.', contentHash };
          }
        }
      }
      addInventory.run(inventory.path, inventory.status, inventory.reason, inventory.contentHash ?? null); counts.inventory++;
      if ((await stat(dbPath)).size > MAX_ARTIFACT) throw new ClecError('PACKAGE_TOO_LARGE', 'Corpus exceeds artifact ceiling.');
    }
    if (!counts.sources) throw new ClecError('EMPTY_CORPUS', 'No usable evidence.');
    db.exec("INSERT INTO search(search) VALUES('optimize')");
  } catch (error) { db?.close(); await rm(staging, { recursive: true, force: true }); throw error; }
  db.close();
  try {
    const bytes = (await stat(dbPath)).size; if (bytes > MAX_ARTIFACT) throw new ClecError('PACKAGE_TOO_LARGE', 'Corpus exceeds artifact ceiling.');
    const digest = createHash('sha256'); for await (const chunk of createReadStream(dbPath)) digest.update(chunk);
    const manifest: Manifest = { formatRevision: 1, artifact: 'corpus.sqlite', ...(artifactUrl === undefined ? {} : { artifactUrl }), bytes, sha256: digest.digest('hex'), counts };
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest) + '\n', { flag: 'wx' });
    await rename(staging, output);
    return manifest;
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
const args = process.argv.slice(2); const options = new Map<string, string>();
try {
  for (let i = 0; i < args.length; i += 2) { const key = args[i]; const value = args[i + 1]; if (!key || !['--workspace', '--intake', '--output', '--artifact-url'].includes(key) || !value || options.has(key)) throw new ClecError('INVALID_ARGUMENT', 'Use --workspace PATH --intake PATH --output PATH [--artifact-url URL].'); options.set(key, value); }
  const workspace = options.get('--workspace'); const intake = options.get('--intake'); const output = options.get('--output'); const artifactUrl = options.get('--artifact-url');
  if (!workspace || !intake || !output) throw new ClecError('INVALID_ARGUMENT', 'Use --workspace PATH --intake PATH --output PATH [--artifact-url URL].');
  process.stdout.write(JSON.stringify({ ok: true, manifest: await build({ workspace, intake, output, ...(artifactUrl === undefined ? {} : { artifactUrl }) }) }) + '\n');
} catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: { code: error instanceof ClecError ? error.code : 'BUILD_FAILED', message: error instanceof Error ? error.message : 'Build failed.' } }) + '\n'); process.exitCode = 1; }
