import type { Citation, EvidenceRead } from '../domain/contracts.js';
import { ClecError } from '../domain/errors.js';
import { EvidenceStore } from './store.js';
export class RunEvidenceReader {
  private readonly reads = new Map<string, EvidenceRead>();
  private readonly allowed = new Set<string>();
  private count = 0;
  private characters = 0;
  constructor(private readonly generation: string, private readonly store: EvidenceStore,
    private readonly maxReads = 8, private readonly maxCharacters = 40_000) {
    if (store.generationId !== generation || !/^[a-f0-9]{64}$/.test(generation)) throw new ClecError('INDEX_MISMATCH', 'Evidence store does not belong to the pinned generation.');
    if (!Number.isInteger(maxReads) || maxReads < 0 || !Number.isInteger(maxCharacters) || maxCharacters < 0) throw new ClecError('READ_BUDGET', 'Invalid evidence budget.');
    this.maxReads = Math.min(8, maxReads);
    this.maxCharacters = Math.min(40_000, maxCharacters);
  }
  allow(passageIds: string[]): void { for (const id of passageIds) this.allowed.add(id); }
  get readCharacters(): number { return this.characters; }
  /** Attempts include refusals, so narrowing can never loop without a bound. */
  get readCalls(): number { return this.count; }
  get remainingReadCalls(): number { return Math.max(0, this.maxReads - this.count); }
  get remainingCharacters(): number { return Math.max(0, this.maxCharacters - this.characters); }
  get uniqueOriginalCharacters(): number { return this.characters; }
  read(passageId: string, expansion: 'section' | 'neighbours' | 'source' = 'neighbours'): EvidenceRead[] {
    if (this.count >= this.maxReads) throw new ClecError('READ_BUDGET', 'Original evidence read attempt budget exhausted.');
    this.count++;
    if (!this.allowed.has(passageId)) throw new ClecError('READ_SCOPE', 'Read requires a locator returned by this run’s search.');
    if (!['section', 'neighbours', 'source'].includes(expansion)) throw new ClecError('READ_SCOPE', 'Unknown evidence expansion.');
    const passage = this.store.passage(passageId);
    const section = this.store.section(passage.sectionId);
    const source = this.store.source(passage.sourceId);
    if (source.version !== passage.sourceVersion || section.sourceVersion !== source.version || section.sourceId !== source.id || section.start !== passage.start || section.end !== passage.end) throw new ClecError('INDEX_MISMATCH', 'Evidence version mismatch.');
    const original = this.store.original(source.id);
    const sections = this.store.sections(source.id).filter(s => expansion === 'source' || (expansion === 'section' ? s.id === section.id : Math.abs(s.order - section.order) <= 1));
    const unseen = sections.filter(s => !this.reads.has(s.id));
    const needed = unseen.reduce((sum, s) => sum + s.end - s.start, 0);
    if (needed > this.remainingCharacters) {
      const canNarrow = this.remainingReadCalls > 0 && sections.some(s => s.end - s.start <= this.remainingCharacters && !this.reads.has(s.id));
      if (canNarrow) throw new ClecError('READ_TOO_LARGE', 'Requested evidence exceeds the remaining character budget. Retry with section scope on a search locator; no evidence was read.');
      throw new ClecError('READ_BUDGET', 'No requested unread complete section fits the remaining evidence budget.');
    }
    this.characters += needed;
    return sections.map(s => {
      const previous = this.reads.get(s.id);
      if (previous) return previous;
      const citation: Citation = { id: `C${this.reads.size + 1}`, generation: this.generation, sourceId: source.id, sourceVersion: source.version,
        sectionId: s.id, start: s.start, end: s.end, quote: original.slice(s.start, s.end), title: source.title, path: source.path, quality: source.quality, date: source.date, dateBasis: source.dateBasis };
      const read = Object.freeze({ citation: Object.freeze(citation), section: Object.freeze(s) });
      this.reads.set(s.id, read);
      return read;
    });
  }
  /** Reconcile explicit host citation references with the unchanged original-read authority. */
  validateCitations(ids: readonly string[]): Citation[] {
    if (ids.some(id => !/^C[1-9]\d*$/.test(id))) throw new ClecError('INVALID_CITATION', 'Malformed citation identity.');
    const all = [...this.reads.values()].map(r => r.citation);
    return [...new Set(ids)].map(id => {
      const citation = all.find(c => c.id === id);
      if (!citation) throw new ClecError('INVALID_CITATION', 'Answer cited evidence not read in this run.');
      const source = this.store.source(citation.sourceId);
      const section = this.store.section(citation.sectionId);
      if (citation.generation !== this.generation || citation.sourceVersion !== source.version || section.sourceId !== source.id || section.sourceVersion !== source.version || citation.start !== section.start || citation.end !== section.end || citation.quote !== this.store.original(source.id).slice(citation.start, citation.end)) throw new ClecError('INVALID_CITATION', 'Citation failed version/read-scope validation.');
      return citation;
    });
  }
}
