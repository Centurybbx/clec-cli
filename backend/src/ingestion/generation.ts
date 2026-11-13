import { mkdir, readFile, writeFile, rename, open, unlink, stat, copyFile, lstat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Generation, InventoryEntry, Source } from '../domain/contracts.js';
import { ClecError, checkAbort } from '../domain/errors.js';
import { hash } from '../domain/hash.js';
import { EvidenceStore } from '../evidence/store.js';
import { passageMarkdown } from './qmd-markdown.js';
import { insideWorkspace, loadManifest } from './manifest.js';
import { SEGMENTATION_REVISION, segment } from './sections.js';
import { buildSettings, settingsKey, textSettingsKey, type BuildSettings } from './settings.js';
import { buildQmd, type QmdBuildMetrics } from './qmd-build.js';
import { atomicWrite, syncDirectory, writeCheckpoint, type EmbeddingCheckpoint } from './embedding-checkpoint.js';
import { recoveryIdentity, verifyGenerationArtifacts } from './generation-identity.js';
import { cloneForRecovery, exists, recoverExchange } from './generation-recovery.js';
import { ingestionError } from './errors.js';

export interface IncrementalMetrics {
  previousGeneration: string | null;
  reused: number; changed: number; added: number; removed: number; reprocessed: number;
  copiedMarkdown: number; generatedMarkdown: number;
  qmd: QmdBuildMetrics;
}
export interface IngestionGeneration extends Generation {
  buildSettings?: BuildSettings;
  incremental?: IncrementalMetrics;
}

export interface GenerationLocation { directory: string; metadata: IngestionGeneration }
async function completedGeneration(directory: string, id: string): Promise<IngestionGeneration> {
  try {
    const metadata = JSON.parse(await readFile(join(directory, 'generation.json'), 'utf8')) as IngestionGeneration;
    const ready = (await readFile(join(directory, 'READY'), 'utf8')).trim();
    if (metadata.id !== id || ready !== id || metadata.collection !== `clec_${id}` ||
        !/^[a-f0-9]{64}$/.test(metadata.manifestHash) || !/^[a-f0-9]{64}$/.test(metadata.intakeFileHash) ||
        !['lexical', 'hybrid'].includes(metadata.searchMode) || !['original-utf16-v1', SEGMENTATION_REVISION].includes(metadata.segmentationRevision) ||
        !Number.isInteger(metadata.sourceCount) || metadata.sourceCount < 1 || !Number.isInteger(metadata.sectionCount) || metadata.sectionCount < 1 || !Array.isArray(metadata.inventory)) {
      throw new Error('Invalid completed generation');
    }
    if (metadata.segmentationRevision === SEGMENTATION_REVISION &&
        (!metadata.buildSettings || !metadata.incremental || metadata.buildSettings.segmentationRevision !== metadata.segmentationRevision ||
         metadata.buildSettings.searchMode !== metadata.searchMode || !metadata.buildSettings.normalizationRevision ||
         !metadata.buildSettings.models?.embed || !metadata.buildSettings.models.rerank || !metadata.buildSettings.models.generate)) {
      throw new Error('Missing build settings');
    }
    for (const name of ['evidence.sqlite', 'qmd.sqlite', 'index.yml']) {
      const file = await stat(join(directory, name));
      if (!file.isFile() || file.size === 0) throw new Error('Missing generation artifact');
    }
    return metadata;
  } catch { throw new ClecError('INVALID_INDEX', 'Generation metadata, READY marker or artifacts are incomplete/mismatched; fail closed and recover manually.'); }
}
export async function currentGeneration(stateRoot: string): Promise<GenerationLocation> {
  let id: string;
  try {
    const pointer = join(stateRoot, 'CURRENT');
    if (!(await lstat(pointer)).isFile()) throw new Error('CURRENT is not a regular file');
    id = (await readFile(pointer, 'utf8')).trim();
  }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') throw new ClecError('NO_INDEX', 'No published generation. Build an intake manifest first.');
    throw new ClecError('INVALID_INDEX', 'CURRENT could not be read; recover manually.');
  }
  if (!/^[a-f0-9]{64}$/.test(id)) throw new ClecError('INVALID_INDEX', 'Invalid generation pointer.');
  const directory = join(resolve(stateRoot), 'generations', id);
  const metadata = await completedGeneration(directory, id);
  return { directory, metadata };
}
export async function buildGeneration(options: { workspace: string; stateRoot: string; manifestPath: string; hybrid: boolean; signal: AbortSignal }): Promise<GenerationLocation> {
  const { workspace, signal } = options;
  const stateRoot = resolve(options.stateRoot);
  await mkdir(join(stateRoot, 'generations'), { recursive: true });
  let lock;
  try { lock = await open(join(stateRoot, 'BUILD.lock'), 'wx', 0o600); }
  catch { throw new ClecError('BUILD_LOCKED', 'Another build holds BUILD.lock; inspect the owner before recovering a stale lock.'); }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await lock.sync();
    await syncDirectory(stateRoot);
    const manifestBytes = await readFile(options.manifestPath);
    const manifest = await loadManifest(options.manifestPath, manifestBytes.toString('utf8'));
    const settings = await buildSettings(options.hybrid, signal);
    checkAbort(signal);
    let previous: GenerationLocation | undefined;
    try { previous = await currentGeneration(stateRoot); }
    catch (error) { if (!(error instanceof ClecError && error.code === 'NO_INDEX')) throw error; }
    const inventory: InventoryEntry[] = [];
    const admitted: Array<{ source: Source; text: string }> = [];
    for (const entry of manifest.sources) {
      checkAbort(signal);
      const denied = entry.status !== 'ready' || entry.type === 'metadata' || /(^|\/)quarantine(\/|$)/i.test(entry.path);
      if (denied) { inventory.push({ path: entry.path, status: entry.status === 'ready' ? 'excluded' : entry.status, reason: 'Excluded by source provenance/status.' }); continue; }
      if (!['.md', '.txt'].includes(extname(entry.path).toLowerCase())) { inventory.push({ path: entry.path, status: 'unsupported', reason: 'This slice admits UTF-8 .md/.txt only; original retained.' }); continue; }
      let bytes: Buffer;
      try {
        const path = await insideWorkspace(workspace, entry.path);
        if ((await stat(path)).size > 100_000_000) throw new ClecError('SOURCE_TOO_LARGE', 'Source exceeds the intake size limit.');
        bytes = await readFile(path);
      } catch (error) {
        if (error instanceof ClecError) throw error;
        inventory.push({ path: entry.path, status: 'unavailable', reason: 'Source could not be read.' }); continue;
      }
      const contentHash = hash(bytes);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { inventory.push({ path: entry.path, status: 'unsupported', reason: 'Invalid UTF-8; extraction required.', contentHash }); continue; }
      if (!text.trim() || text.includes('\0')) { inventory.push({ path: entry.path, status: text.includes('\0') ? 'quarantined' : 'empty', reason: 'Empty text or binary NUL content.', contentHash }); continue; }
      const source: Source = { ...entry, id: hash(entry.path), version: hash(JSON.stringify({ ...entry, contentHash })), contentHash, date: entry.date, dateBasis: entry.dateBasis };
      admitted.push({ source, text });
      inventory.push({ path: entry.path, status: 'indexed', reason: 'Explicitly admitted; quality label retained.', contentHash });
    }
    if (!admitted.length) throw new ClecError('EMPTY_CORPUS', 'No usable evidence; CURRENT was not changed.');
    const manifestHash = hash(JSON.stringify(manifest));
    const id = hash(JSON.stringify({ manifestHash, inventory, versions: admitted.map(a => a.source.version), settings }));
    const directory = join(stateRoot, 'generations', id);
    const identity = recoveryIdentity(id, manifestHash, hash(manifestBytes), admitted, settings, signal);
    // CURRENT was validated before any exchange; never move its directory.
    if (previous?.metadata.id === id && await exists(join(stateRoot, 'generations', '.embedding-recovery.json'))) {
      throw new ClecError('RECOVERY_REFUSED', 'Recovery intent names CURRENT; manual inspection required.');
    }
    await recoverExchange(join(stateRoot, 'generations'), identity, signal);
    let existing: IngestionGeneration | undefined;
    if (await exists(join(directory, 'READY'))) existing = await completedGeneration(directory, id);
    if (!existing) {
      let checkpoint: EmbeddingCheckpoint;
      let resuming = false;
      if (await exists(directory)) {
        if (previous?.metadata.id === id) throw new ClecError('INVALID_INDEX', 'Published generation cannot be resumed.');
        checkpoint = await cloneForRecovery(join(stateRoot, 'generations'), identity, signal);
        resuming = true;
      } else {
        // Unique staging name; never mutate a published generation or reuse a partial build.
        const staging = join(stateRoot, 'generations', `.building-${randomUUID()}`);
        await mkdir(join(staging, 'markdown'), { recursive: true });
        await writeFile(join(staging, 'BUILDING.json'), JSON.stringify({ id }));
        const evidence = new EvidenceStore(join(staging, 'evidence.sqlite'), false);
        let prior: EvidenceStore | undefined;
        let sectionCount = 0;
        let reused = 0, changed = 0, added = 0, removed = 0, reprocessed = 0;
        let copiedMarkdown = 0, generatedMarkdown = 0;
        try {
          prior = previous ? new EvidenceStore(join(previous.directory, 'evidence.sqlite')) : undefined;
          const oldSources = new Map(prior?.sources().map(source => [source.id, source]) ?? []);
          const nextIds = new Set(admitted.map(item => item.source.id));
          removed = [...oldSources.keys()].filter(sourceId => !nextIds.has(sourceId)).length;
          const priorSettings = previous?.metadata.buildSettings;
          const reusable = priorSettings !== undefined && textSettingsKey(priorSettings) === textSettingsKey(settings);
          for (const { source, text } of admitted) {
            checkAbort(signal);
            const oldSource = oldSources.get(source.id);
            if (!oldSource) added++;
            else if (oldSource.version !== source.version) changed++;
            if (prior && previous && reusable && oldSource?.version === source.version) {
              const bundle = prior.exportSourceBundle(source.id);
              if (bundle.original !== text) throw new ClecError('INVALID_INDEX', 'Previous original does not match the admitted source version.');
              evidence.importSourceBundle(bundle);
              sectionCount += bundle.sections.length;
              for (const passage of bundle.passages) {
                checkAbort(signal);
                await copyFile(join(previous.directory, 'markdown', `${passage.id}.md`), join(staging, 'markdown', `${passage.id}.md`));
                copiedMarkdown++;
              }
              reused++;
            } else {
              if (oldSource?.version === source.version) reprocessed++;
              const sections = segment(source, text);
              const passages = evidence.add(source, text, sections);
              sectionCount += sections.length;
              for (const passage of passages) {
                checkAbort(signal);
                await writeFile(join(staging, 'markdown', `${passage.id}.md`), passageMarkdown(source, passage, text));
                generatedMarkdown++;
              }
            }
          }
        } finally { evidence.close(); prior?.close(); }
        if (sectionCount !== identity.sectionCount) throw new ClecError('INVALID_INDEX', 'Prepared evidence count does not match independently derived identity.');
        await verifyGenerationArtifacts(staging, identity, signal);
        // Persist complete prepared evidence before exposing the deterministic directory.
        for (const path of [join(staging, 'evidence.sqlite'), ...identity.markdown.map(item => join(staging, 'markdown', item.path))]) {
          const file = await open(path, 'r');
          try { await file.sync(); } finally { await file.close(); }
        }
        await syncDirectory(join(staging, 'markdown'));
        checkpoint = { schemaVersion: 1, phase: 'prepared', identity,
          preparation: { previousGeneration: previous?.metadata.id ?? null, reused, changed, added, removed, reprocessed, copiedMarkdown, generatedMarkdown },
          work: { initialPending: null, remaining: null, successfulUnits: 0, attempts: 0, chargedMs: 0, active: null } };
        await writeCheckpoint(staging, checkpoint);
        await rename(staging, directory);
        await syncDirectory(join(stateRoot, 'generations'));
      }
      const collection = `clec_${id}`;
      const canSeed = !resuming && previous?.metadata.buildSettings !== undefined && settingsKey(previous.metadata.buildSettings) === settingsKey(settings);
      const qmd = await buildQmd(directory, collection, identity.sectionCount, settings, signal, { checkpoint, resuming }, canSeed && previous ? { directory: previous.directory, id: previous.metadata.id, collection: previous.metadata.collection } : undefined);
      checkAbort(signal);
      await verifyGenerationArtifacts(directory, identity, signal);
      existing = { id, createdAt: new Date().toISOString(), collection, manifestHash, intakePath: resolve(options.manifestPath), intakeFileHash: hash(manifestBytes), intakeSourceCount: manifest.sources.length, readySelectedSourceCount: manifest.sources.filter(s => s.status === 'ready' && s.type !== 'metadata').length, sourceCount: admitted.length, sectionCount: identity.sectionCount, inventory, searchMode: settings.searchMode, segmentationRevision: SEGMENTATION_REVISION,
        buildSettings: settings, incremental: { ...checkpoint.preparation, qmd } };
      await atomicWrite(directory, 'generation.json', JSON.stringify(existing, null, 2) + '\n');
      checkAbort(signal);
      await atomicWrite(directory, 'READY', `${id}\n`);
    }
    checkAbort(signal);
    existing = await completedGeneration(directory, id);
    checkAbort(signal);
    await atomicWrite(stateRoot, 'CURRENT', `${id}\n`);
    return { directory, metadata: existing };
  } catch (error) { throw ingestionError(error, signal); }
  finally { await lock.close(); await unlink(join(stateRoot, 'BUILD.lock')); await syncDirectory(stateRoot); }
}
