import type { Candidate } from '../domain/contracts.js';
import { variants } from './normalize.js';

export interface NavigationCandidate extends Candidate {
  /** Untrusted navigation only. Must be read through RunEvidenceReader to cite. */
  navigation: { start: number; end: number; text: string };
}
export function navigation(candidate: Candidate, original: string, anchors: string[]): NavigationCandidate {
  const { start, end } = candidate.passage;
  const body = original.slice(start, end);
  let match = -1;
  for (const term of anchors) {
    for (const variant of variants(term)) {
      const position = body.toLowerCase().indexOf(variant.toLowerCase());
      if (position >= 0 && (match < 0 || position < match)) match = position;
    }
  }
  let from = start + Math.max(0, match - 100);
  if (from > start && /[\uDC00-\uDFFF]/.test(original[from]!)) from--;
  let to = Math.min(end, from + 420);
  if (to < end && /[\uDC00-\uDFFF]/.test(original[to]!)) to--;
  return { ...candidate, navigation: { start: from, end: to, text: original.slice(from, to) } };
}
