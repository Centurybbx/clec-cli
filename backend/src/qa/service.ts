import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AppConfig } from '../config.js';
import { deriveAnswerability, NO_HITS_TEXT, referencedIds, renderAnswer, type AnswerBlock } from '../domain/answer.js';
import { failureReason, type DiagnosticSink } from '../diagnostics/contracts.js';
import { LocalDiagnosticSink } from '../diagnostics/local.js';
import { EvidenceContext } from './evidence-context.js';
import type { Emit, EvidenceRead } from '../domain/contracts.js';
import { ClecError, checkAbort, publicError } from '../domain/errors.js';
import { EvidenceStore } from '../evidence/store.js';
import { RunEvidenceReader } from '../evidence/reader.js';
import { currentGeneration } from '../ingestion/generation.js';
import { QmdHttpSearch } from '../search/qmd-http.js';
import type { ExecutionProgressEvent, ValidatedAnswer } from '../sessions/types.js';
import { answerWithPi } from './pi.js';
import { retrievalQuestion } from './conversation.js';
import { assertQmdGeneration } from './qmd-generation.js';
import type { SearchFilter } from '../search/filters.js';

export interface QaRequest {
  runId: string; question: string; signal: AbortSignal;
  /** Only genuine original user questions; retrieval disambiguation, never evidence. */
  priorQuestions?: readonly string[];
  /** Applied to initial and supplementary retrieval before upstream ranking. */
  filter?: SearchFilter;
  manager?: SessionManager;
  associate?: () => void;
  pinGeneration(generation: string): void;
  diagnostics: DiagnosticSink;
  emit(event: ExecutionProgressEvent): void;
  reportMetrics?(metrics: Record<string, number>): void;
}

/** Shared structured business service. Caller owns identity, deadline and cancellation. */
export async function answerQuestion(config: AppConfig, request: QaRequest): Promise<ValidatedAnswer> {
  const { question, signal } = request;
  const startedAt = performance.now();
  const diagnostics = request.diagnostics;
  diagnostics.record({ runId: request.runId, stage: 'qa', code: 'BEGIN' });
  let hasPrimaryFailure = false;
  let evidence: EvidenceStore | undefined;
  let reader: RunEvidenceReader | undefined;
  let searches = 0;
  let searchAttempts = 0;
  let searchResults = 0;
  let readAttempts = 0;
  let modelMetrics: Record<string, number> = { modelCalls: 0, modelRequestAttempts: 0, contextAdmissionUnits: 0, toolCalls: 0, usageReports: 0, usageComplete: 1, costEstimateAvailable: 0 };
  const metrics = () => ({ ...modelMetrics, searches, searchAttempts, searchResults, readAttempts,
    readCalls: reader?.readCalls ?? 0, readCharacters: reader?.readCharacters ?? 0, elapsedMs: performance.now() - startedAt });
  try {
    if (!question.trim() || question.length > 2000) throw new ClecError('INVALID_QUERY', 'Question must contain 1–2000 characters.');
    checkAbort(signal);
    const generation = await currentGeneration(config.stateRoot);
    checkAbort(signal);
    request.pinGeneration(generation.metadata.id);
    evidence = new EvidenceStore(join(generation.directory, 'evidence.sqlite'));
    reader = new RunEvidenceReader(generation.metadata.id, evidence);
    const query = retrievalQuestion(question, request.priorQuestions ?? []);
    const priorScopeQuestion = query !== question ? request.priorQuestions?.at(-1) : undefined;
    const search = new QmdHttpSearch(config.qmdUrl, generation.metadata, evidence, { query: question,
      ...(priorScopeQuestion ? { priorQuery: priorScopeQuestion } : {}), ...(request.filter ? { filter: request.filter } : {}) });
    const manager = request.manager ?? SessionManager.inMemory(config.workspace);
    manager.appendCustomEntry('clec_run_begin', { runId: request.runId, generation: generation.metadata.id });
    // Persist a genuine user turn before setup. This creates the Pi file without fake replies.
    manager.appendMessage({ role: 'user', content: question, timestamp: Date.now() });
    request.associate?.();
    const performSearch = async (query: string, activeSignal: AbortSignal) => {
      checkAbort(activeSignal);
      searchAttempts++;
      if (searches >= 2) throw new ClecError('SEARCH_BUDGET', 'Only one directed supplementary search is allowed.');
      searches++;
      await assertQmdGeneration(config, generation, activeSignal);
      const candidates = await search.search(query, activeSignal);
      searchResults += candidates.length;
      reader!.allow(candidates.map(c => c.passage.id));
      request.emit({ type: 'search', query, supplementary: searches > 1, candidates });
      return candidates;
    };
    const context = new EvidenceContext(generation.metadata.id, () => ({ readAttempts: Math.max(0, 8 - readAttempts),
      originalUtf16: reader!.remainingCharacters, supplementarySearches: Math.max(0, 2 - searches) }));
    const finish = (answerability: ValidatedAnswer['answerability'], blocks: AnswerBlock[], text: string,
      citations: ValidatedAnswer['citations']): ValidatedAnswer => {
      checkAbort(signal);
      const result: ValidatedAnswer = { validated: true, answerability, blocks, text, citations, metrics: metrics() };
      // This Pi marker remains insufficient for recovery without a host-completed run.
      manager.appendCustomEntry('clec_run_committed', { runId: request.runId });
      return result;
    };
    const candidates = await performSearch(query, signal);
    if (!candidates.length) return finish('no_hits', [], NO_HITS_TEXT, []);
    const navigation = context.navigation(candidates);
    const read = (passageId: string, expansion: 'section' | 'neighbours' | 'source', activeSignal: AbortSignal) => {
      checkAbort(activeSignal);
      if (readAttempts >= 8) throw new ClecError('READ_BUDGET', 'Original evidence read attempt budget exhausted.');
      readAttempts++;
      const reads = reader!.read(passageId, expansion);
      request.emit({ type: 'read', citations: reads.map(r => r.citation) });
      return reads;
    };
    const initial: EvidenceRead[] = [];
    for (const candidate of candidates.slice(0, 2)) {
      try { initial.push(...read(candidate.passage.id, 'neighbours', signal)); }
      catch (error) {
        if (!(error instanceof ClecError) || error.code !== 'READ_TOO_LARGE') throw error;
        try { initial.push(...read(candidate.passage.id, 'section', signal)); }
        catch (smaller) { if (!(smaller instanceof ClecError) || smaller.code !== 'READ_TOO_LARGE') throw smaller; }
      }
    }
    const result = await answerWithPi(config, { runId: request.runId, generation: generation.metadata.id,
      question, retrievalQuery: query, manager, evidence: context, diagnostics,
      reportMetrics: value => { modelMetrics = value; } }, navigation, context.admit(initial), {
        search: async (directedQuery, activeSignal) => context.navigation(await performSearch(directedQuery, activeSignal)),
        read: (readLocator, expansion, activeSignal) => context.admit(read(context.resolve(readLocator), expansion, activeSignal)),
      }, signal);
    modelMetrics = result.metrics;
    checkAbort(signal);
    const blocks = context.normalize(result.blocks);
    // Reader authority rechecks all used IDs, versions, original ranges and quotes.
    const citations = reader.validateCitations(referencedIds(blocks));
    const text = renderAnswer(blocks, citations);
    return finish(deriveAnswerability(blocks), blocks, text, citations);
  } catch (error) {
    hasPrimaryFailure = true;
    diagnostics.record({ runId: request.runId, stage: 'qa', code: 'FAILURE', reason: failureReason(error) });
    throw error;
  } finally {
    let cleanupFailure: unknown;
    let cleanupFailed = false;
    for (const cleanup of [() => evidence?.close(), () => request.reportMetrics?.(metrics())]) {
      try { cleanup(); }
      catch (error) {
        if (!cleanupFailed) { cleanupFailed = true; cleanupFailure = error; }
        diagnostics.record({ runId: request.runId, stage: 'cleanup', code: 'CLEANUP_FAILURE', reason: failureReason(error) });
      }
    }
    if (!hasPrimaryFailure && cleanupFailed) throw cleanupFailure;
    if (!hasPrimaryFailure) diagnostics.record({ runId: request.runId, stage: 'qa', code: 'SUCCESS' });
  }
}

/** CLI event adapter; no model/runtime implementation lives here. */
export async function ask(config: AppConfig, question: string, emit: Emit, callerSignal: AbortSignal, filter?: SearchFilter): Promise<boolean> {
  const runId = randomUUID();
  const diagnostics = new LocalDiagnosticSink(config.diagnosticPath);
  const deadline = AbortSignal.timeout(config.deadlineMs);
  const signal = AbortSignal.any([callerSignal, deadline]);
  try {
    diagnostics.record({ runId, stage: 'cli', code: 'BEGIN' });
    const result = await answerQuestion(config, { runId, question, signal, diagnostics, ...(filter ? { filter } : {}),
      pinGeneration: generation => emit({ type: 'start', runId, generation }), emit });
    checkAbort(signal);
    emit({ type: 'text', text: result.text });
    for (const citation of result.citations) emit({ type: 'citation', citation });
    emit({ type: 'complete', runId, answerability: result.answerability, blocks: result.blocks, metrics: result.metrics });
    diagnostics.record({ runId, stage: 'cli', code: 'SUCCESS' });
    return true;
  } catch (error) {
    diagnostics.record({ runId, stage: 'cli', code: 'FAILURE', reason: failureReason(error) });
    const safe = signal.aborted ? { code: deadline.aborted && !callerSignal.aborted ? 'TIMEOUT' : 'CANCELLED', message: 'Run stopped; no answer completed.' } : publicError(error);
    emit({ type: 'error', runId, ...safe });
    return false;
  }
}
