import type { Answerability, AnswerBlock } from '../domain/answer.js';
import type { Citation, QaEvent } from '../domain/contracts.js';
import type { SearchFilter } from '../domain/search-filter.js';

export type RunState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
export interface PiSessionReference { id: string; file: string }
export interface HostSession {
  id: string; title: string; createdAt: string; updatedAt: string;
  piSession: PiSessionReference | null;
}
export interface PublicRunError { code: string; message: string }
export interface HostRun {
  id: string; requestId: string; sessionId: string; question: string; state: RunState;
  filter: SearchFilter;
  createdAt: string; startedAt: string | null; finishedAt: string | null; settledAt: string | null;
  timeoutMs: number; generation: string | null; error: PublicRunError | null;
  result: ValidatedAnswer | null;
  /** Last measured usage, including failed/cancelled runs; absent measurements stay absent. */
  metrics: Record<string, number> | null;
}
export interface HostMessage {
  id: string; sessionId: string; runId: string; role: 'user' | 'assistant';
  status: 'input' | 'partial' | 'final'; text: string; citations: Citation[]; createdAt: string;
}
export type ExecutionProgressEvent = Extract<QaEvent, { type: 'search' | 'read' }>;
export type ProgressEvent = Extract<QaEvent, { type: 'search' | 'read' | 'text' | 'citation' }>;
export type SessionEventData =
  | { type: 'queued'; question: string; filter: SearchFilter }
  | { type: 'running' }
  | { type: 'generation'; generation: string }
  | { type: 'pi_session'; reference: PiSessionReference }
  | { type: 'progress'; event: ProgressEvent }
  | { type: 'terminal'; state: Exclude<RunState, 'queued' | 'running'>; error: PublicRunError | null; result: ValidatedAnswer | null }
  | { type: 'metrics'; metrics: Record<string, number> }
  | { type: 'settled' };
export interface SessionEvent {
  cursor: number; sessionId: string; runId: string; createdAt: string; data: SessionEventData;
}
export interface ValidatedAnswer {
  /** Structural and original-source integrity only; does not prove semantic entailment. */
  validated: true;
  answerability: Answerability;
  blocks: AnswerBlock[];
  text: string; citations: Citation[]; metrics: Record<string, number>;
}
export interface RunContext {
  readonly runId: string; readonly requestId: string; readonly sessionId: string;
  readonly question: string; readonly startedAt: string; readonly deadlineAt: string;
  readonly filter: Readonly<SearchFilter>;
  readonly piSession: Readonly<PiSessionReference> | null;
}
export interface RunOutput {
  /** Pin once before emitting evidence; the actual evidence layer chooses this value. */
  pinGeneration(generation: string): void;
  /** Must point to a file under the store's configured Pi directory. */
  associatePiSession(reference: PiSessionReference): void;
  emit(event: ExecutionProgressEvent): void;
  /** Cleanup measurements may arrive after terminal cancellation, before settlement. */
  recordMetrics(metrics: Record<string, number>): void;
}
export type RunExecutor = (
  context: Readonly<RunContext>, signal: AbortSignal, output: Readonly<RunOutput>,
) => Promise<ValidatedAnswer>;
export interface EnqueueRun {
  sessionId: string; requestId: string; question: string; timeoutMs?: number;
  filter?: SearchFilter;
}
export interface EventPageOptions { after?: number; limit?: number; runId?: string }
