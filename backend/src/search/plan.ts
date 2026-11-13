import type { SearchOptions } from '@tobilu/qmd';
import { normalizeForSearch } from './normalize.js';

// Grammatical/question scaffolding only; no corpus vocabulary or evaluation terms.
const scaffolding = new Set(('的 了 呢 吗 啊 是 在 有 和 与 及 或 把 被 对 从 给 这 那 一个 一些 我 你 他 她 它 我们 你们 他们 什么 为什么 如何 怎么 哪些 是否 可以 应该 请 请问 关于 中 中的 里 里面 这个 这种 这些 那个 那些 the a an and or of to in on for is are was were do does did what why how which can could would should please explain describe question current').split(' '));
const words = new Intl.Segmenter('zh', { granularity: 'word' });
export interface LexicalPlan {
  /** Input stays unchanged for observability and answer intent. */
  originalQuery: string;
  anchors: string[];
  searches: NonNullable<SearchOptions['queries']>;
}

/** Separate lexical alternatives because QMD joins words with AND and treats
 * unspaced CJK as an exact phrase. Bounded deterministic planning, no LLM. */
export function lexicalPlan(originalQuery: string, hybrid: boolean): LexicalPlan {
  const canonical = normalizeForSearch(originalQuery).replace(/\s+/g, ' ').trim();
  const tokens = [...words.segment(canonical)].filter(s => s.isWordLike).map(s => s.segment);
  const literal = canonical.match(/[a-z][a-z\d]*(?:[._/-][a-z\d]+)*|\d+(?:[.,]\d+)*(?:%|年|岁)?/gi) ?? [];
  const meaningful = tokens.filter(t => !scaffolding.has(t.toLowerCase()) && (t.length > 1 || /[\dA-Za-z]/.test(t)));
  // Preserve input order within each category. Codes/names/numbers and longer
  // words survive before single generic fragments in an unusually long input.
  const unique = [...new Set([...literal.filter(t => !scaffolding.has(t.toLowerCase())), ...meaningful])];
  const anchors = unique.slice(0, 10);
  if (!anchors.length && canonical && tokens.length <= 2) anchors.push(canonical.replaceAll('"', ''));
  const searches: LexicalPlan['searches'] = anchors.map(query => ({ type: 'lex', query: `"${query.replaceAll('"', '')}"` }));
  // At most two adjacent content-word phrases add precision, never a mandatory
  // all-question conjunction. Singles retain recall when phrasing differs.
  for (let i = 0; i + 1 < tokens.length && searches.length < 12; i++) {
    const a = tokens[i]!, b = tokens[i + 1]!;
    if (!anchors.includes(a) || !anchors.includes(b) || !/\p{Script=Han}/u.test(a + b)) continue;
    const joined = a + b;
    if (canonical.includes(joined)) searches.push({ type: 'lex', query: `"${joined}"` });
  }
  // A single semantic query carries the whole question, canonicalized like the
  // indexed text. intent below independently preserves the original question.
  if (hybrid) searches.push({ type: 'vec', query: canonical.replace(/(^|\s)-(?=[\w"])/g, '$1') });
  return { originalQuery, anchors, searches };
}
