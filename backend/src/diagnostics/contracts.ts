export type DiagnosticStage = 'qa' | 'admission' | 'provider' | 'scheduler' | 'cleanup' | 'http' | 'cli';
export type DiagnosticCode = 'BEGIN' | 'SUCCESS' | 'FAILURE' | 'CLEANUP_FAILURE' | 'ADMITTED' | 'REFUSED' |
  'ABORT_REQUESTED' | 'HTTP_RESPONSE' | 'FIRST_PROVIDER_EVENT' | 'STREAM_END' | 'STREAM_ABORT' | 'LOCAL_SETTLED' | 'CANCELLED' | 'TIMED_OUT' | 'COMMITTED';
export const FAILURE_REASONS = ['ANSWER_PROTOCOL', 'INVALID_CITATION', 'READ_SCOPE', 'READ_TOO_LARGE', 'READ_BUDGET',
  'SEARCH_BUDGET', 'TOOL_BUDGET', 'MODEL_BUDGET', 'MODEL_NOT_SETTLED', 'MODEL_FAILED', 'MODEL_UNAVAILABLE',
  'INDEX_MISMATCH', 'SEARCH_UNAVAILABLE', 'API_KEY_REQUIRED', 'INVALID_ANSWER', 'INVALID_EVIDENCE', 'INVALID_EVENT',
  'GENERATION_REQUIRED', 'RUN_ABORTED', 'CANCELLED', 'TIMEOUT', 'UNKNOWN'] as const;
export type FailureReason = typeof FAILURE_REASONS[number];
export function failureReason(error: unknown): FailureReason {
  try {
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return FAILURE_REASONS.find(reason => reason === code) ?? 'UNKNOWN';
  } catch { return 'UNKNOWN'; }
}
/** Fixed diagnostic vocabulary; never serialize arbitrary error properties. */
export const ANSWER_PROTOCOL_REASONS = ['INVALID_JSON', 'STRUCTURE', 'GAP_EXTRA_FIELDS', 'TEXT_BOUND',
  'UNKNOWN_EVIDENCE', 'REFERENCE_STRUCTURE', 'MISSING_ANSWER_OR_GAP'] as const;
export type AnswerProtocolDiagnosticReason = typeof ANSWER_PROTOCOL_REASONS[number];
export const COUNT_FIELDS = ['requestedUnits', 'contextBytes', 'systemBytes', 'messageBytes', 'toolBytes', 'outputReserve',
  'reservedUnits', 'limitUnits', 'modelCalls', 'readAttempts', 'readCharacters', 'searches', 'searchResults', 'blocks', 'citations'] as const;
export type DiagnosticCounts = Partial<Record<typeof COUNT_FIELDS[number], number>>;
export interface DiagnosticRecord {
  runId: string; requestOrdinal?: number; stage: DiagnosticStage; code: DiagnosticCode;
  reason?: FailureReason; answerProtocolReason?: AnswerProtocolDiagnosticReason; counts?: DiagnosticCounts;
}
/** Implementations must never throw and must serialize only allowlisted fields. */
export interface DiagnosticSink { record(event: DiagnosticRecord): void; readonly dropped: number }
export function silentDiagnostics(): DiagnosticSink { return { dropped: 0, record: () => {} }; }
