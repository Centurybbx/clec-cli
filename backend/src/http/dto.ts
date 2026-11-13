import type { Candidate, Citation } from '../domain/contracts.js';
import type { HostMessage, HostRun, HostSession, ProgressEvent, PublicRunError, SessionEvent, ValidatedAnswer } from '../sessions/index.js';

function citation(c: Citation) {
  return { id: c.id, generation: c.generation, sourceId: c.sourceId, sourceVersion: c.sourceVersion,
    sectionId: c.sectionId, start: c.start, end: c.end, quote: c.quote, title: c.title,
    path: c.path, quality: c.quality, date: c.date, dateBasis: c.dateBasis };
}
const failures: Readonly<Record<string, string>> = {
  RUN_FAILED: 'Execution failed. No answer was completed.',
  INVALID_RESULT: 'The answer or evidence could not be validated. No answer was completed.',
  CANCELLED: 'Run was cancelled. No answer was completed.',
  TIMED_OUT: 'Run deadline expired. No answer was completed.',
  INTERRUPTED: 'Execution was interrupted. Submit a new request to try again.',
};
function failure(error: PublicRunError | null) {
  if (error === null) return null;
  const code = Object.hasOwn(failures, error.code) ? error.code : 'RUN_FAILED';
  return { code, message: failures[code]! };
}
function answer(result: ValidatedAnswer | null) {
  if (result === null) return null;
  return { validated: result.validated, answerability: result.answerability, text: result.text, blocks: result.blocks,
    citations: result.citations.map(citation),
    metrics: Object.fromEntries(Object.entries(result.metrics).filter(([, n]) => Number.isFinite(n) && n >= 0)) };
}
export function session(s: HostSession) {
  return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt };
}
export function run(r: HostRun) {
  return { id: r.id, requestId: r.requestId, sessionId: r.sessionId, question: r.question, state: r.state,
    filter: r.filter,
    createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt, settledAt: r.settledAt,
    timeoutMs: r.timeoutMs, generation: r.generation, error: failure(r.error), result: answer(r.result), metrics: r.metrics };
}
export function message(m: HostMessage) {
  return { id: m.id, sessionId: m.sessionId, runId: m.runId, role: m.role, status: m.status,
    text: m.text, citations: m.citations.map(citation), createdAt: m.createdAt };
}
function candidate(c: Candidate) {
  const p = c.passage; const s = c.source;
  return { score: c.score,
    ...(c.navigation ? { navigation: { start: c.navigation.start, end: c.navigation.end, text: c.navigation.text } } : {}),
    passage: { id: p.id, sectionId: p.sectionId, sourceId: p.sourceId, sourceVersion: p.sourceVersion, start: p.start, end: p.end },
    source: { id: s.id, version: s.version, title: s.title, path: s.path, type: s.type, quality: s.quality,
      status: s.status, date: s.date, dateBasis: s.dateBasis } };
}
function progress(p: ProgressEvent) {
  switch (p.type) {
    case 'search': return { type: p.type, query: p.query, supplementary: p.supplementary, candidates: p.candidates.map(candidate) };
    case 'read': return { type: p.type, citations: p.citations.map(citation) };
    case 'text': return { type: p.type, text: p.text };
    case 'citation': return { type: p.type, citation: citation(p.citation) };
  }
}
export function event(e: SessionEvent) {
  const d = e.data;
  const data = (() => {
    switch (d.type) {
      case 'queued': return { type: d.type, question: d.question, filter: d.filter };
      case 'running': case 'settled': case 'pi_session': return { type: d.type };
      case 'generation': return { type: d.type, generation: d.generation };
      case 'metrics': return { type: d.type, metrics: d.metrics };
      case 'progress': return { type: d.type, event: progress(d.event) };
      case 'terminal': return { type: d.type, state: d.state, error: failure(d.error), result: answer(d.result) };
    }
  })();
  return { cursor: e.cursor, sessionId: e.sessionId, runId: e.runId, createdAt: e.createdAt, data };
}
