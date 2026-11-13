import { failureReason, silentDiagnostics, type DiagnosticSink } from '../diagnostics/contracts.js';
import { performance } from 'node:perf_hooks';
import type { Citation } from '../domain/contracts.js';
import { SessionStore } from './store.js';
import type {
  EnqueueRun, HostRun, ExecutionProgressEvent, PublicRunError, RunContext, RunExecutor,
  RunOutput, SessionEvent,
} from './types.js';
import { answer, citation, duration, requireValue, sameCitation, SessionError } from './validation.js';

interface ActiveRun { controller: AbortController; done: Promise<void>; expires: number }
export interface RunSchedulerOptions { concurrency?: number; defaultTimeoutMs?: number; diagnostics?: DiagnosticSink }
const cancelled: PublicRunError = { code: 'CANCELLED', message: 'Run was cancelled. No answer was completed.' };
const timedOut: PublicRunError = { code: 'TIMED_OUT', message: 'Run deadline expired. No answer was completed.' };
const failed: PublicRunError = { code: 'RUN_FAILED', message: 'Execution failed. No answer was completed.' };
const invalid: PublicRunError = { code: 'INVALID_RESULT', message: 'The answer or evidence could not be validated. No answer was completed.' };

function copy<T>(value: T): T { return structuredClone(value); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

/** Serialization is held until executor settlement, including after cancellation/timeout. */
export class RunScheduler {
  private readonly diagnostics: DiagnosticSink;
  private readonly concurrency: number;
  private readonly defaultTimeout: number;
  private readonly queued: string[] = [];
  private readonly active = new Map<string, ActiveRun>();
  private readonly listeners = new Set<(event: Readonly<SessionEvent>) => void>();
  private readonly waiters = new Map<string, Set<(run: HostRun) => void>>();
  private accepting = true;
  private pumpScheduled = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(private readonly store: SessionStore, private readonly executor: RunExecutor, options: RunSchedulerOptions = {}) {
    this.diagnostics = options.diagnostics ?? silentDiagnostics();
    this.concurrency = options.concurrency ?? 4;
    this.defaultTimeout = options.defaultTimeoutMs ?? 90_000;
    requireValue(Number.isSafeInteger(this.concurrency) && this.concurrency > 0 && this.concurrency <= 1024);
    duration(this.defaultTimeout);
    store.attachScheduler();
  }

  enqueueRun(input: EnqueueRun): HostRun {
    requireValue(this.accepting, 'SCHEDULER_CLOSED', 'Scheduler is shutting down.');
    const timeoutMs = input.timeoutMs ?? this.defaultTimeout; duration(timeoutMs);
    const { run, event } = this.store.enqueue(input.sessionId, input.requestId, input.question, timeoutMs, input.filter);
    if (event) {
      this.queued.push(run.id);
      this.publish(event);
      this.schedulePump();
    }
    return this.store.getRun(run.id);
  }

  /** Durable before callback. Reconnect from readEvents; callbacks are a wake-up hint only. */
  subscribe(listener: (event: Readonly<SessionEvent>) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private publish(event: SessionEvent | null): void {
    if (!event) return;
    const waiting = this.waiters.get(event.runId);
    if (waiting) {
      const run = this.store.getRun(event.runId);
      if (run.settledAt !== null) {
        this.waiters.delete(event.runId);
        for (const resolve of waiting) resolve(copy(run));
      }
    }
    const envelope = freeze(copy(event));
    for (const listener of [...this.listeners]) {
      // A disconnected transport must never alter the execution lifecycle.
      try { listener(envelope); } catch { /* Read the durable log on reconnect. */ }
    }
  }
  cancelRun(id: string): HostRun {
    const run = this.store.getRun(id);
    if (run.state === 'queued' || run.state === 'running') {
      const queuedIndex = this.queued.indexOf(id);
      if (queuedIndex !== -1) this.queued.splice(queuedIndex, 1);
      this.diagnostics.record({ runId: id, stage: 'scheduler', code: 'CANCELLED' });
      this.publish(this.store.terminal(id, 'cancelled', cancelled));
      this.active.get(id)?.controller.abort();
      this.schedulePump();
    }
    return this.store.getRun(id);
  }
  /** Resolves after actual executor settlement, not merely the terminal status event. */
  async waitForRun(id: string): Promise<HostRun> {
    const run = this.store.getRun(id);
    if (run.settledAt !== null) return run;
    return new Promise<HostRun>(resolve => {
      const waiting = this.waiters.get(id) ?? new Set<(run: HostRun) => void>();
      waiting.add(resolve);
      this.waiters.set(id, waiting);
    });
  }
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.accepting = false;
    for (const id of [...this.queued]) this.cancelRun(id);
    for (const id of this.active.keys()) this.cancelRun(id);
    this.shutdownPromise = Promise.all([...this.active.values()].map(active => active.done)).then(() => undefined);
    return this.shutdownPromise;
  }
  private schedulePump(): void {
    if (this.pumpScheduled || !this.accepting) return;
    this.pumpScheduled = true;
    queueMicrotask(() => { this.pumpScheduled = false; this.pump(); });
  }
  private pump(): void {
    if (!this.accepting) return;
    const occupied = new Set([...this.active.keys()].map(id => this.store.getRun(id).sessionId));
    for (let index = 0; index < this.queued.length && this.active.size < this.concurrency;) {
      const id = this.queued[index]!; const run = this.store.getRun(id);
      if (run.state !== 'queued') { this.queued.splice(index, 1); continue; }
      if (occupied.has(run.sessionId)) { index++; continue; }
      this.queued.splice(index, 1);
      occupied.add(run.sessionId);
      const controller = new AbortController();
      // Delay executor invocation until the active lease and promise are installed.
      const active: ActiveRun = { controller, expires: performance.now() + run.timeoutMs, done: Promise.resolve() };
      const event = this.store.start(id);
      this.active.set(id, active);
      active.done = Promise.resolve().then(() => this.execute(id, active));
      this.publish(event);
    }
  }
  private expire(id: string, active: ActiveRun): void {
    const run = this.store.getRun(id);
    if (run.state !== 'running') return;
    this.diagnostics.record({ runId: id, stage: 'scheduler', code: 'TIMED_OUT' });
    this.publish(this.store.terminal(id, 'timed_out', timedOut));
    active.controller.abort();
  }
  private checkActive(id: string, active: ActiveRun): HostRun {
    if (performance.now() >= active.expires) this.expire(id, active);
    requireValue(!active.controller.signal.aborted, 'RUN_ABORTED', 'Run has stopped.');
    return this.store.requireRunning(id);
  }
  private async execute(id: string, active: ActiveRun): Promise<void> {
    const timer = setTimeout(() => this.expire(id, active), Math.max(1, Math.ceil(active.expires - performance.now())));
    const reads: Citation[] = [];
    let sawCandidates = false;
    let sawSearch = false;
    this.diagnostics.record({ runId: id, stage: 'scheduler', code: 'BEGIN' });
    try {
      const run = this.checkActive(id, active);
      const context: RunContext = freeze({
        runId: id, requestId: run.requestId, sessionId: run.sessionId, question: run.question,
        filter: run.filter,
        startedAt: run.startedAt!, deadlineAt: new Date(Date.parse(run.startedAt!) + run.timeoutMs).toISOString(),
        piSession: this.store.getSession(run.sessionId).piSession,
      });
      const output: RunOutput = Object.freeze({
        recordMetrics: (metrics: Record<string, number>): void => {
          this.publish(this.store.recordMetrics(id, copy(metrics)));
        },
        pinGeneration: (generation: string): void => {
          this.checkActive(id, active);
          this.publish(this.store.pinGeneration(id, generation));
        },
        associatePiSession: (reference: Parameters<RunOutput['associatePiSession']>[0]): void => {
          this.checkActive(id, active);
          this.publish(this.store.associatePiSession(id, reference));
        },
        emit: (event: ExecutionProgressEvent): void => {
          const current = this.checkActive(id, active);
          requireValue(current.generation !== null, 'GENERATION_REQUIRED');
          const safe = copy(event);
          requireValue(safe !== null && typeof safe === 'object', 'INVALID_EVENT');
          requireValue(['search', 'read'].includes(safe.type), 'INVALID_EVENT');
          if (safe.type === 'search') {
            requireValue(typeof safe.query === 'string' && typeof safe.supplementary === 'boolean' && Array.isArray(safe.candidates), 'INVALID_EVENT');
            sawSearch = true;
            sawCandidates ||= safe.candidates.length > 0;
          }
          if (safe.type === 'read') {
            requireValue(Array.isArray(safe.citations), 'INVALID_EVENT');
            const additions: Citation[] = [];
            for (const item of safe.citations) {
              citation(item, current.generation);
              const previous = [...reads, ...additions].find(read => read.id === item.id);
              requireValue(!previous || sameCitation(previous, item), 'INVALID_EVIDENCE');
              if (!previous) additions.push(item);
            }
            this.publish(this.store.progress(id, { type: 'progress', event: safe }));
            reads.push(...additions);
            return;
          }
          this.publish(this.store.progress(id, { type: 'progress', event: safe }));
        },
      });
      const result = copy(await this.executor(context, active.controller.signal, output));
      const current = this.checkActive(id, active);
      answer(result, current.generation, reads);
      requireValue(result.answerability !== 'no_hits' || (sawSearch && !sawCandidates), 'INVALID_ANSWER');
      this.checkActive(id, active);
      const committed = this.store.complete(id, result);
      for (const event of committed) this.publish(event);
      this.diagnostics.record({ runId: id, stage: 'scheduler', code: 'COMMITTED' });
    } catch (error) {
      this.diagnostics.record({ runId: id, stage: 'scheduler', code: 'FAILURE', reason: failureReason(error) });
      // Never reflect provider text, SDK exceptions, ClecError messages or arbitrary codes.
      const publicFailure = error instanceof SessionError && ['INVALID_ANSWER', 'INVALID_EVIDENCE', 'INVALID_EVENT', 'GENERATION_REQUIRED'].includes(error.code) ? invalid : failed;
      this.publish(this.store.terminal(id, 'failed', publicFailure));
    } finally {
      clearTimeout(timer);
      const settled = this.store.settle(id);
      this.diagnostics.record({ runId: id, stage: 'scheduler', code: 'LOCAL_SETTLED' });
      this.active.delete(id);
      this.publish(settled);
      this.schedulePump();
    }
  }
}
