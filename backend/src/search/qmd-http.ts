import type { Candidate, Generation } from '../domain/contracts.js';
import type { SearchOptions } from '@tobilu/qmd';
import { ClecError, checkAbort } from '../domain/errors.js';
import { EvidenceStore } from '../evidence/store.js';
import { lexicalPlan } from './plan.js';
import { eligible, metadataFilter, type SearchFilter } from './filters.js';
import { navigation } from './navigation.js';
import { resolveSourceScope } from './source-scope.js';
export type { SearchFilter } from './filters.js';

export interface EvidenceSearch {
  search(query: string, signal: AbortSignal): Promise<Candidate[]>;
}
export class QmdHttpSearch implements EvidenceSearch {
  private readonly endpoint: URL;
  private readonly filter: SearchFilter;
  constructor(url: string, private readonly generation: Generation, private readonly evidence: EvidenceStore, scope?: { query: string; priorQuery?: string; filter?: SearchFilter }) {
    this.endpoint = new URL('/query', url);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(this.endpoint.hostname) || this.endpoint.protocol !== 'http:' || this.endpoint.username || this.endpoint.password) {
      throw new ClecError('INVALID_CONFIG', 'QMD endpoint must be local HTTP for this milestone.');
    }
    if (evidence.generationId !== generation.id) throw new ClecError('INDEX_MISMATCH', 'Search evidence is not bound to the pinned generation.');
    // Resolve once for the run. Supplementary searches cannot widen it; only
    // the external caller's lists use the 64-item admission cap.
    this.filter = resolveSourceScope(scope?.query ?? '', evidence.sources(), scope?.filter, scope?.priorQuery);
  }
  async search(query: string, signal: AbortSignal): Promise<Candidate[]> {
    checkAbort(signal);
    if (!query.trim() || query.length > 2000) throw new ClecError('INVALID_QUERY', 'Search query must contain 1–2000 characters.');
    const filter = this.filter;
    // An explicitly empty eligible scope is a valid no-hit result, not failure.
    if (filter.sourceIds?.length === 0 || filter.types?.length === 0) return [];
    if (!this.evidence.sources().some(source => eligible(source, filter))) return [];
    const plan = lexicalPlan(query, this.generation.searchMode === 'hybrid');
    if (!plan.searches.length) return [];
    const predicate = metadataFilter(filter);
    const options: SearchOptions = { queries: plan.searches, collections: [this.generation.collection],
      limit: 40, candidateLimit: 40, rerank: this.generation.searchMode === 'hybrid', intent: query,
      ...(predicate ? { filter: predicate } : {}) };
    let value: unknown;
    try {
      // Public HTTP /query maps searches to SDK SearchOptions.queries; never
      // send query (which invokes upstream automatic LLM expansion).
      const { queries, ...rest } = options;
      const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...rest, searches: queries }), signal });
      if (!response.ok) { await response.body?.cancel(); throw new ClecError('SEARCH_UNAVAILABLE', `QMD returned HTTP ${response.status}; no answer completed.`); }
      if (!response.body) throw new ClecError('SEARCH_PROTOCOL', 'QMD returned an empty body.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          checkAbort(signal);
          const { value: chunk, done } = await reader.read();
          if (done) break;
          bytes += chunk.byteLength;
          if (bytes > 2_000_000) throw new ClecError('SEARCH_PROTOCOL', 'QMD response exceeded the protocol limit.');
          chunks.push(chunk);
        }
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw new ClecError('SEARCH_PROTOCOL', 'QMD returned invalid UTF-8 JSON.'); }
      } finally {
        // Preserve the original protocol/cancellation error if transport cleanup
        // also fails. cancel() stops buffering/downloading the response body.
        try { await reader.cancel(); } catch { /* Already closed/errored. */ }
        reader.releaseLock();
      }
    } catch (error) {
      checkAbort(signal);
      if (error instanceof ClecError) throw error;
      throw new ClecError('SEARCH_UNAVAILABLE', 'QMD is unavailable or returned an invalid response.');
    }
    if (!value || typeof value !== 'object' || !('results' in value) || !Array.isArray(value.results)) throw new ClecError('SEARCH_PROTOCOL', 'QMD did not return a results array.');
    if (value.results.length > 40) throw new ClecError('SEARCH_PROTOCOL', 'QMD returned too many results.');
    const candidates = new Map<string, Candidate>();
    for (const hit of value.results as unknown[]) {
      if (!hit || typeof hit !== 'object' || !('file' in hit) || typeof hit.file !== 'string' || !('score' in hit) || typeof hit.score !== 'number' || !Number.isFinite(hit.score)) throw new ClecError('SEARCH_PROTOCOL', 'Malformed QMD hit.');
      const prefix = `qmd://${this.generation.collection}/`;
      if (!hit.file.startsWith(prefix)) throw new ClecError('INDEX_MISMATCH', 'QMD served a different generation.');
      let locator: string;
      try { locator = decodeURIComponent(hit.file.slice(prefix.length)); }
      catch { throw new ClecError('INDEX_MISMATCH', 'Malformed QMD passage locator.'); }
      if (!/^[a-f0-9]{64}\.md$/.test(locator)) throw new ClecError('INDEX_MISMATCH', 'Unmapped QMD passage locator.');
      const passage = this.evidence.passage(locator.slice(0, -3));
      const source = this.evidence.source(passage.sourceId);
      if (source.version !== passage.sourceVersion) throw new ClecError('INDEX_MISMATCH', 'Passage version does not match original evidence.');
      // These are protocol assertions, not post-top-k scope filtering. Every
      // result must already satisfy the upstream metadata predicate.
      if (!eligible(source, filter)) throw new ClecError('INDEX_MISMATCH', 'QMD returned a passage outside the requested metadata scope.');
      if (!('metadata' in hit) || !hit.metadata || typeof hit.metadata !== 'object' ||
        !('sourceId' in hit.metadata) || hit.metadata.sourceId !== source.id ||
        !('sourceVersion' in hit.metadata) || hit.metadata.sourceVersion !== source.version ||
        !('sourceType' in hit.metadata) || hit.metadata.sourceType !== source.type ||
        ('date' in hit.metadata ? hit.metadata.date : undefined) !== source.date ||
        ('dateBasis' in hit.metadata ? hit.metadata.dateBasis : undefined) !== source.dateBasis) throw new ClecError('INDEX_MISMATCH', 'QMD metadata does not match original evidence. Rebuild this index.');
      const previous = candidates.get(passage.id);
      if (!previous || previous.score < hit.score) candidates.set(passage.id, { passage, source, score: hit.score });
    }
    // Merge by passage only; do not collapse independent same-source passages.
    return [...candidates.values()].sort((a, b) => b.score - a.score || a.passage.id.localeCompare(b.passage.id)).slice(0, 12)
      .map(candidate => navigation(candidate, this.evidence.original(candidate.source.id), plan.anchors));
  }
}
