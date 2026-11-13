import { ClecError } from '../domain/errors.js';

export const EMBEDDING_REVISION = 'qmd-regex-bounded-work-strict-document-v3';
export const DEFAULT_EMBEDDING_MAX_DURATION_MS = 2 * 60 * 60 * 1000;
export interface EmbeddingPolicy {
  chunkStrategy: 'regex';
  maxDocuments: number;
  maxInputBytes: number;
  maxDocumentBytes: number;
  maxChunksPerDocument: number;
  maxDurationMs: number;
  maxTotalDurationMs: number;
}
/** Finite cooperative budgets. Native work must settle before cleanup. */
export function embeddingPolicy(overrides: Partial<EmbeddingPolicy> = {}): EmbeddingPolicy {
  const policy: EmbeddingPolicy = { chunkStrategy: 'regex', maxDocuments: 8, maxInputBytes: 1_000_000,
    maxDocumentBytes: 1_000_000, maxChunksPerDocument: 2048, maxDurationMs: DEFAULT_EMBEDDING_MAX_DURATION_MS,
    maxTotalDurationMs: 24 * 60 * 60 * 1000, ...overrides };
  for (const key of ['maxDocuments', 'maxInputBytes', 'maxDocumentBytes', 'maxChunksPerDocument', 'maxDurationMs', 'maxTotalDurationMs'] as const) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0 ||
      ((key === 'maxDurationMs' || key === 'maxTotalDurationMs') && policy[key] > 2_147_483_647)) {
      throw new ClecError('INVALID_INDEX', `Embedding ${key} must be a finite positive safe integer within its supported range.`);
    }
  }
  if (policy.chunkStrategy !== 'regex' || policy.maxDocuments === Number.MAX_SAFE_INTEGER ||
    policy.maxDocumentBytes > policy.maxInputBytes || policy.maxDurationMs > policy.maxTotalDurationMs) {
    throw new ClecError('INVALID_INDEX', 'Embedding policy limits are inconsistent.');
  }
  return policy;
}
