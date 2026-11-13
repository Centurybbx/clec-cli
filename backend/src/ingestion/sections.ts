import type { Section, Source } from '../domain/contracts.js';
import { hash } from '../domain/hash.js';
export const SEGMENTATION_REVISION = 'original-utf16-v2-bounded-qa';
const WINDOW = 5000;

/** Explicit line labels only; never infer a speaker or a semantic exchange. */
function qaStarts(text: string): number[] {
  const labels = [...text.matchAll(/^(?:#{1,6}[ \t]+)?(Q|A|問|答|问题|回答|問題|答案)[ \t]*[:：][^\r\n]*/gm)];
  const questions = new Set(['Q', '問', '问题', '問題']);
  const starts: number[] = [];
  for (let i = 0; i < labels.length - 1; i++) {
    if (questions.has(labels[i]![1]!) && !questions.has(labels[i + 1]![1]!)) starts.push(labels[i]!.index);
  }
  return starts;
}

/** Exact, gap-free UTF-16 ranges. Contiguous ranges may continue either Q or A. */
export function segment(source: Source, text: string): Section[] {
  const ranges: Array<{ start: number; end: number; boundary: Section['boundary'] }> = [];
  if (text.length <= WINDOW) ranges.push({ start: 0, end: text.length, boundary: 'whole' });
  else {
    const headings = source.type === 'transcript' ? [] : [...text.matchAll(/^#{1,6} .+$/gm)].map(m => m.index);
    const starts = source.type === 'qa' ? qaStarts(text) : [];
    // Heading boundaries must not cut an explicitly labelled Q/A exchange.
    const boundaries = starts.length ? starts : headings;
    const cuts = [...new Set([0, ...boundaries, text.length])].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      let start = cuts[i]!;
      const stop = cuts[i + 1]!;
      while (start < stop) {
        let end = Math.min(start + WINDOW, stop);
        if (end < stop) {
          const line = text.lastIndexOf('\n', end - 1);
          if (line >= start) end = line + 1;
          // An overlong single line still needs a bounded cut, preserving CRLF/surrogates.
          if (text[end - 1] === '\r' && text[end] === '\n') end--;
          if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
        }
        ranges.push({ start, end, boundary: !starts.length && headings.length && end === stop && start === cuts[i] ? 'heading' : 'contiguous' });
        start = end;
      }
    }
  }
  return ranges.map((r, order) => ({ ...r, order, sourceId: source.id, sourceVersion: source.version,
    id: hash(`${source.version}:${r.start}:${r.end}:${SEGMENTATION_REVISION}`) }));
}
