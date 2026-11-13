import type { QMDStore, EmbedWorkResult } from '@tobilu/qmd';
import { checkAbort, ClecError } from '../domain/errors.js';
import { embeddingPolicy, type EmbeddingPolicy } from './embedding-policy.js';
import { remainingBudget, reserveAttempt, settleAttempt, type EmbeddingCheckpoint } from './embedding-checkpoint.js';

export interface EmbeddingWorkLedger {
  schemaVersion: 1;
  resumable: false;
  initialPending: number;
  maxWorkUnits: number;
  elapsedMs: number;
  chunksEmbedded: number;
  chunksCopied: number;
  units: Array<EmbedWorkResult & { sequence: number }>;
}
function invalid(message: string): never { throw new ClecError('INVALID_INDEX', message); }
const count = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/** Exclusive, immutable collection window. Only public SDK facts authorize progress.
 * The separate versioned checkpoint owns identity, attempts and inherited budget. */
export async function runEmbeddingWork(store: Pick<QMDStore, 'embedWork' | 'getStatus'>, collection: string,
  policyInput: EmbeddingPolicy, model: string, signal: AbortSignal,
  record: (ledger: EmbeddingWorkLedger) => Promise<void>,
  recovery: { directory: string; checkpoint: EmbeddingCheckpoint }): Promise<EmbeddingWorkLedger> {
  const policy = embeddingPolicy(policyInput);
  checkAbort(signal);
  const start = performance.now();
  const { directory, checkpoint } = recovery;
  const inherited = checkpoint.work.chargedMs;
  let accountedAt = start;
  const initialPending = (await store.getStatus()).needsEmbedding;
  if (!count(initialPending)) invalid('QMD initial pending count is unavailable.');
  const ledger: EmbeddingWorkLedger = { schemaVersion: 1, resumable: false, initialPending,
    maxWorkUnits: initialPending, elapsedMs: performance.now() - start, chunksEmbedded: 0, chunksCopied: 0, units: [] };
  if (checkpoint.work.remaining === null || initialPending > checkpoint.work.remaining) invalid('Recovered database pending exceeds checkpoint baseline.');
  checkpoint.work.remaining = initialPending;
  let remaining = initialPending;
  const identity = checkpoint.identity.embedding;
  if (!identity || identity.model !== model) invalid('Checkpoint embedding identity is unavailable.');
  await record(ledger);
  while (remaining > 0) {
    checkAbort(signal);
    checkpoint.work.chargedMs += performance.now() - accountedAt;
    if (ledger.units.length >= initialPending) invalid('NO_PROGRESS: process exceeded its pending-document work bound.');
    const attemptStart = performance.now();
    const available = await reserveAttempt(directory, checkpoint, remaining);
    try {
      const result = await store.embedWork({ collection, chunkStrategy: policy.chunkStrategy,
        maxDocuments: policy.maxDocuments, maxInputBytes: policy.maxInputBytes,
        maxDocumentBytes: policy.maxDocumentBytes, maxChunksPerDocument: policy.maxChunksPerDocument,
        maxDurationMs: available, signal });
      checkAbort(signal);
      if (![result.pendingBefore, result.selectedDocuments, result.selectedBytes, result.completedDocuments,
        result.remainingDocuments, result.chunksEmbedded, result.chunksCopied].every(count) ||
        !Number.isFinite(result.durationMs) || result.durationMs < 0) invalid('QMD work returned invalid counters.');
      if (!result.identity || result.identity.model !== model || result.identity.chunkStrategy !== 'regex' ||
        !/^[a-f0-9]{6}$/.test(result.identity.fingerprint) ||
        result.identity.fingerprint !== identity.fingerprint) invalid('QMD embedding work identity changed.');
      if (result.remainingDocuments > 0 && result.completedDocuments === 0) throw new ClecError('EMBEDDING_NO_PROGRESS', 'Embedding work completed no documents.');
      if (result.pendingBefore !== remaining || result.selectedDocuments <= 0 ||
        result.selectedDocuments > policy.maxDocuments || result.selectedBytes <= 0 || result.selectedBytes > policy.maxInputBytes ||
        result.completedDocuments !== result.selectedDocuments || result.remainingDocuments >= remaining ||
        remaining - result.remainingDocuments !== result.completedDocuments || result.chunksCopied !== 0 ||
        result.chunksEmbedded < result.completedDocuments ||
        result.chunksEmbedded > result.selectedDocuments * policy.maxChunksPerDocument ||
        (result.outcome !== 'complete' && result.outcome !== 'bounded') ||
        (result.outcome === 'complete') !== (result.remainingDocuments === 0)) invalid('QMD embedding work violated bounded progress.');
      ledger.units.push({ ...result, sequence: ledger.units.length + 1 });
      ledger.chunksEmbedded += result.chunksEmbedded;
      ledger.chunksCopied += result.chunksCopied;
      ledger.elapsedMs = inherited + performance.now() - start;
      remaining = result.remainingDocuments;
      await record(ledger);
      checkpoint.work.remaining = remaining;
      checkpoint.work.successfulUnits++;
      accountedAt = performance.now();
      await settleAttempt(directory, checkpoint, accountedAt - attemptStart);
    } catch (error) {
      // The awaited SDK operation has settled. Preserve the primary failure even
      // when accounting persistence also fails; the durable reservation remains.
      if (checkpoint.work.active) {
        try { await settleAttempt(directory, checkpoint, performance.now() - attemptStart); } catch { /* disk reservation is conservative */ }
      }
      throw error;
    }
    checkAbort(signal);
    if (remainingBudget(checkpoint) <= 0) throw new ClecError('EMBEDDING_BUDGET_EXHAUSTED', 'Embedding build time budget exhausted.');
  }
  checkAbort(signal);
  if ((await store.getStatus()).needsEmbedding !== 0) invalid('QMD pending work remains after embedding.');
  checkAbort(signal);
  ledger.elapsedMs = inherited + performance.now() - start;
  checkpoint.work.chargedMs += performance.now() - accountedAt;
  if (remainingBudget(checkpoint) <= 0) throw new ClecError('EMBEDDING_BUDGET_EXHAUSTED', 'Embedding build time budget exhausted.');
  await record(ledger);
  checkAbort(signal);
  return ledger;
}
