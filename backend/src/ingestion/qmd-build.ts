import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createStore, type UpdateResult } from '@tobilu/qmd';
import { checkAbort, ClecError } from '../domain/errors.js';
import type { BuildSettings } from './settings.js';
import { runEmbeddingWork, type EmbeddingWorkLedger } from './embedding-work.js';
import { atomicWrite, reserveAttempt, settleAttempt, writeCheckpoint, remainingBudget, type EmbeddingCheckpoint } from './embedding-checkpoint.js';
import { durableBackup } from './sqlite-backup.js';

export interface QmdBuildMetrics {
  seededFromGeneration: string | null;
  update: UpdateResult;
  retired: UpdateResult | null;
  embed: EmbeddingWorkLedger | null;
}
interface Seed { directory: string; id: string; collection: string }

/** Only public SDK operations on a private, coherent SQLite backup. No QMD SQL. */
export async function buildQmd(directory: string, collection: string, expectedPassages: number, settings: BuildSettings, signal: AbortSignal, recovery: { checkpoint: EmbeddingCheckpoint; resuming: boolean }, seed?: Seed): Promise<QmdBuildMetrics> {
  const dbPath = join(directory, 'qmd.sqlite');
  const configPath = join(directory, 'index.yml');
  const collections: Record<string, { path: string; pattern: string }> = {
    [collection]: { path: join(directory, 'markdown'), pattern: '**/*.md' },
  };
  if (seed) {
    await durableBackup(join(seed.directory, 'qmd.sqlite'), dbPath);
    const empty = join(directory, 'retired-collection');
    await mkdir(empty);
    collections[seed.collection] = { path: empty, pattern: '**/*.md' };
  }
  checkAbort(signal);
  const checkpoint = recovery.checkpoint;
  if (recovery.resuming) checkpoint.phase = 'embedding';
  let attemptStart = performance.now();
  await reserveAttempt(directory, checkpoint, checkpoint.work.remaining);
  let qmd: Awaited<ReturnType<typeof createStore>> | undefined;
  let failed = false;
  let result: QmdBuildMetrics | undefined;
  try {
    await atomicWrite(directory, 'index.yml', JSON.stringify({ collections, models: settings.models }, null, 2));
    qmd = await createStore({ dbPath, configPath });
    checkAbort(signal);
    // Register/index the destination BEFORE retiring the old collection: content hashes
    // and vectors remain referenced throughout QMD's automatic content cleanup.
    const update = await qmd.update({ collections: [collection], onProgress: () => checkAbort(signal) });
    if (update.skipped) throw new ClecError('INVALID_INDEX', 'QMD skipped generated evidence files; generation was not published.');
    checkAbort(signal);
    let retired: UpdateResult | null = null;
    if (seed) {
      retired = await qmd.update({ collections: [seed.collection], onProgress: () => checkAbort(signal) });
      if (retired.skipped) throw new ClecError('INVALID_INDEX', 'QMD could not retire the previous collection.');
      if (!await qmd.removeCollection(seed.collection)) throw new ClecError('INVALID_INDEX', 'QMD previous collection registration was missing.');
    }
    checkAbort(signal);
    const actual = await qmd.listCollections();
    if (actual.length !== 1 || actual[0]?.name !== collection || actual[0]?.pwd !== join(directory, 'markdown') || actual[0]?.active_count !== expectedPassages) {
      throw new ClecError('INVALID_INDEX', 'QMD collection relocation did not complete.');
    }
    // Public discovery verifies current typed extraction on EVERY passage,
    // independently of later search rank windows. Unknown dates stay absent.
    const metadata = await qmd.listMetadata({ collection, keyLimit: 10, valueLimit: 1,
      filter: { operator: 'and', operands: [
        { field: 'sourceId', operator: 'type', value: 'string' },
        { field: 'sourceType', operator: 'type', value: 'string' },
        { field: 'sourceVersion', operator: 'type', value: 'string' },
      ] } });
    if (metadata.documents !== expectedPassages || metadata.filteredDocuments !== expectedPassages) throw new ClecError('INVALID_INDEX', 'QMD typed metadata coverage is incomplete.');
    // Check the immutable destination window before scheduling bounded work.
    // Independent public health facts still authorize final completion.
    let status = await qmd.getStatus();
    if (status.totalDocuments !== expectedPassages || status.pendingMetadata !== 0 || status.collections.length !== 1 ||
        status.collections[0]?.name !== collection || status.collections[0]?.path !== join(directory, 'markdown') ||
        status.collections[0]?.documents !== expectedPassages) {
      throw new ClecError('INVALID_INDEX', 'QMD active document or metadata coverage is incomplete.');
    }
    const pending = settings.searchMode === 'hybrid' ? status.needsEmbedding : 0;
    if (!Number.isSafeInteger(pending) || pending < 0 || (checkpoint.work.remaining !== null && pending > checkpoint.work.remaining)) {
      throw new ClecError('INVALID_INDEX', 'Recovered database pending exceeds its trusted baseline.');
    }
    checkpoint.work.initialPending ??= pending;
    checkpoint.work.remaining = pending;
    checkpoint.phase = 'embedding';
    await settleAttempt(directory, checkpoint, performance.now() - attemptStart);
    const embed = settings.searchMode === 'hybrid' ? await runEmbeddingWork(qmd, collection, settings.embeddingPolicy, settings.models.embed, signal,
      ledger => atomicWrite(directory, 'embedding-work.json', JSON.stringify(ledger, null, 2) + '\n'), { directory, checkpoint }) : null;
    attemptStart = performance.now();
    await reserveAttempt(directory, checkpoint, checkpoint.work.remaining);
    checkAbort(signal);
    status = await qmd.getStatus();
    if (status.totalDocuments !== expectedPassages || status.pendingMetadata !== 0 || status.collections.length !== 1 ||
      status.collections[0]?.name !== collection || status.collections[0]?.path !== join(directory, 'markdown') ||
      status.collections[0]?.documents !== expectedPassages) throw new ClecError('INVALID_INDEX', 'QMD collection changed during embedding.');
    if (settings.searchMode === 'hybrid') {
      const health = await qmd.getIndexHealth();
      // Exactly one active collection makes these global checks authoritative
      // for the destination. Missing/unavailable partition health fails closed.
      if (!status.hasVectorIndex || status.needsEmbedding !== 0 || health.needsEmbedding !== 0 ||
          health.totalDocs !== expectedPassages || health.missingVectorPartitions !== 0) {
        throw new ClecError('INVALID_INDEX', 'QMD embedding or vector partition coverage is incomplete; generation was not published.');
      }
    }
    checkAbort(signal);
    result = { seededFromGeneration: seed?.id ?? null, update, retired, embed };
  } catch (error) { failed = true; throw error; }
  finally {
    // Always await disposal; preserve an operation's primary failure if disposal
    // also fails. On success disposal must succeed before the caller can publish.
    try { await qmd?.close(); } catch (error) { if (!failed) { failed = true; throw error; } }
    finally {
      if (checkpoint.work.active) {
        try { await settleAttempt(directory, checkpoint, performance.now() - attemptStart); } catch (error) { if (!failed) throw error; }
      }
    }
  }
  checkAbort(signal);
  if (remainingBudget(checkpoint) <= 0) throw new ClecError('EMBEDDING_BUDGET_EXHAUSTED', 'Embedding build time budget exhausted.');
  checkpoint.phase = 'closed';
  await writeCheckpoint(directory, checkpoint);
  return result!;
}
