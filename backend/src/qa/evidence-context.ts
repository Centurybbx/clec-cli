import { randomUUID } from 'node:crypto';
import type { AnswerBlock } from '../domain/answer.js';
import type { Candidate, Citation, EvidenceRead } from '../domain/contracts.js';
import { ClecError } from '../domain/errors.js';

/** Model projection only: the original reader's allowlist remains the authority. */
export class EvidenceContext {
  private readonly namespace = randomUUID();
  private readonly locators = new Map<string, string>();
  private readonly passageHandles = new Map<string, string>();
  private readonly originals = new Map<string, { handle: string; read: EvidenceRead }>();
  private readonly handles = new Map<string, Citation>();
  constructor(private readonly generation: string, private readonly budgets: () => Record<string, number>) {}
  navigation(candidates: readonly Candidate[]) {
    return candidates.map(candidate => {
      let readLocator = this.passageHandles.get(candidate.passage.id);
      if (!readLocator) {
        readLocator = `R:${this.namespace}:${this.locators.size + 1}`;
        this.passageHandles.set(candidate.passage.id, readLocator);
        this.locators.set(readLocator, candidate.passage.id);
      }
      const source = candidate.source;
      return { readLocator, title: source.title, date: source.date, dateBasis: source.dateBasis, sourceType: source.type,
        navigation: { status: 'UNREAD', ...(candidate.navigation ?? {}) } };
    });
  }
  resolve(readLocator: string): string {
    const passage = this.locators.get(readLocator);
    if (!passage) throw new ClecError('READ_SCOPE', 'Unknown or stale current-run read handle.');
    return passage;
  }
  admit(reads: readonly EvidenceRead[]) {
    const projection = new Map<string, ReturnType<EvidenceContext['project']>>();
    const reusedEvidenceIds = new Set<string>();
    for (const read of reads) {
      const c = read.citation;
      if (c.generation !== this.generation) throw new ClecError('INVALID_CITATION', 'Read generation does not match this run.');
      const key = JSON.stringify([c.generation, c.sourceVersion, c.sourceId, c.sectionId, c.start, c.end]);
      let original = this.originals.get(key);
      if (!original) {
        const handle = `E:${this.namespace}:${this.originals.size + 1}`;
        original = { handle, read }; this.originals.set(key, original); this.handles.set(handle, c);
        projection.set(original.handle, this.project(original));
      } else if (!projection.has(original.handle)) reusedEvidenceIds.add(original.handle);
    }
    // Earlier full projections remain in Pi history; repeat reads return their same handle only.
    return { originalEvidence: [...projection.values()], reusedEvidenceIds: [...reusedEvidenceIds] };
  }
  private project({ handle, read }: { handle: string; read: EvidenceRead }) {
    const c = read.citation;
    return { evidenceId: handle, metadata: { generation: c.generation, sourceId: c.sourceId, sourceVersion: c.sourceVersion,
      sectionId: c.sectionId, title: c.title, path: c.path, quality: c.quality, date: c.date, dateBasis: c.dateBasis },
      scope: { start: c.start, end: c.end, boundary: read.section.boundary }, originalText: c.quote };
  }
  snapshot() { return { issuedEvidenceIds: [...this.handles.keys()], remainingBudgets: this.budgets() }; }
  get issuedEvidenceIds(): ReadonlySet<string> { return new Set(this.handles.keys()); }
  normalize(blocks: readonly AnswerBlock[]): AnswerBlock[] {
    return blocks.map(block => block.kind === 'gap' ? { ...block } : { ...block, evidenceIds: block.evidenceIds.map(id => {
      const citation = this.handles.get(id);
      if (!citation) throw new ClecError('INVALID_CITATION', 'Unknown current-run evidence handle.');
      return citation.id;
    }) });
  }
}
