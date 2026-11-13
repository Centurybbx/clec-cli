import { EmbedWorkError } from '@tobilu/qmd';
import { ClecError } from '../domain/errors.js';

/** Normalize only typed/confirmed interruptions, after native work and close have settled. */
export function ingestionError(error: unknown, signal: AbortSignal): unknown {
  if (error instanceof ClecError) return error;
  if (error instanceof EmbedWorkError) {
    if (error.code === 'TIMEOUT') return new ClecError('EMBEDDING_TIMEOUT', 'Embedding work exceeded its reserved lifetime; generation was not published.');
    if (error.code === 'CANCELLED' && signal.aborted) return new ClecError('CANCELLED', 'Build cancelled; generation was not published.');
    if (error.code === 'DOCUMENT_LIMIT') return new ClecError('EMBEDDING_DOCUMENT_LIMIT', 'A document exceeds the versioned embedding policy.');
    if (error.code === 'NO_PROGRESS') return new ClecError('EMBEDDING_NO_PROGRESS', 'Embedding work made no progress.');
  }
  // Node file streams, AbortSignal.throwIfAborted and SDK cause wrapping.
  let cause: unknown = error;
  const seen = new Set<unknown>();
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    if (signal.aborted && (cause === signal.reason || cause.name === 'AbortError' ||
        ('code' in cause && cause.code === 'ABORT_ERR'))) return new ClecError('CANCELLED', 'Build cancelled; generation was not published.');
    cause = cause.cause;
  }
  return error;
}
