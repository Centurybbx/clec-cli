import type { Citation } from './contracts.js';
import { ClecError } from './errors.js';

export type Answerability = 'supported' | 'partial' | 'insufficient_evidence' | 'no_hits';
export type AnswerBlock =
  | { kind: 'answer' | 'context'; text: string; evidenceIds: string[] }
  | { kind: 'gap'; text: string };
export const ANSWER_LIMITS = Object.freeze({ rawUtf8Bytes: 65_536, blocks: 16, blockUtf16: 4096, textUtf16: 16_384, references: 64 });
export const NO_HITS_TEXT = '在目前索引中未找到可支持此問題的原始資料。這不代表整個資料庫或其他來源沒有答案；可以提供集號、原句或縮小問題。';
export type AnswerProtocolReason = 'INVALID_JSON' | 'STRUCTURE' | 'GAP_EXTRA_FIELDS' | 'TEXT_BOUND' |
  'UNKNOWN_EVIDENCE' | 'REFERENCE_STRUCTURE' | 'MISSING_ANSWER_OR_GAP';
/** Internal, content-free rejection; public code and messages remain unchanged. */
export class AnswerProtocolError extends ClecError {
  constructor(public readonly reason: AnswerProtocolReason) {
    super('ANSWER_PROTOCOL', reason === 'INVALID_JSON' ? 'Model final answer was not valid JSON.' :
      'Answer did not satisfy the structured answer contract.');
  }
}
function protocol(condition: unknown, reason: AnswerProtocolReason): asserts condition {
  if (!condition) throw new AnswerProtocolError(reason);
}
/** Pure structural validation; neither source entailment nor requested-part coverage is proved. */
export function validateBlocks(value: unknown, allowed: ReadonlySet<string>): AnswerBlock[] {
  protocol(Array.isArray(value) && value.length > 0 && value.length <= ANSWER_LIMITS.blocks, 'STRUCTURE');
  let units = 0; let references = 0;
  const blocks = value.map((item: unknown): AnswerBlock => {
    protocol(item !== null && typeof item === 'object' && !Array.isArray(item), 'STRUCTURE');
    const block = item as Record<string, unknown>;
    protocol(block.kind === 'answer' || block.kind === 'context' || block.kind === 'gap', 'STRUCTURE');
    const keys = Object.keys(block);
    protocol(keys.sort().join(',') === (block.kind === 'gap' ? 'kind,text' : 'evidenceIds,kind,text'),
      block.kind === 'gap' && keys.some(key => key !== 'kind' && key !== 'text') ? 'GAP_EXTRA_FIELDS' : 'STRUCTURE');
    protocol(typeof block.text === 'string' && block.text.trim().length > 0 && block.text.length <= ANSWER_LIMITS.blockUtf16, 'TEXT_BOUND');
    protocol(!/\[(?:C[^\]]*|[0-9]+|[ER]:[^\]]*)\]/i.test(block.text), 'REFERENCE_STRUCTURE');
    units += block.text.length;
    if (block.kind === 'gap') return { kind: 'gap', text: block.text };
    protocol(Array.isArray(block.evidenceIds) && block.evidenceIds.length > 0, 'REFERENCE_STRUCTURE');
    references += block.evidenceIds.length;
    protocol(block.evidenceIds.every(id => typeof id === 'string'), 'REFERENCE_STRUCTURE');
    protocol(block.evidenceIds.every(id => allowed.has(id)), 'UNKNOWN_EVIDENCE');
    protocol(new Set(block.evidenceIds).size === block.evidenceIds.length, 'REFERENCE_STRUCTURE');
    return { kind: block.kind as 'answer' | 'context', text: block.text, evidenceIds: [...block.evidenceIds] as string[] };
  });
  protocol(units <= ANSWER_LIMITS.textUtf16, 'TEXT_BOUND');
  protocol(references <= ANSWER_LIMITS.references, 'REFERENCE_STRUCTURE');
  deriveAnswerability(blocks);
  return blocks;
}
export function parseModelAnswer(raw: string, allowed: ReadonlySet<string>): AnswerBlock[] {
  protocol(new TextEncoder().encode(raw).byteLength <= ANSWER_LIMITS.rawUtf8Bytes, 'TEXT_BOUND');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new AnswerProtocolError('INVALID_JSON'); }
  protocol(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).join(',') === 'blocks', 'STRUCTURE');
  return validateBlocks((value as { blocks: unknown }).blocks, allowed);
}
export function deriveAnswerability(blocks: readonly AnswerBlock[]): Exclude<Answerability, 'no_hits'> {
  const answer = blocks.some(block => block.kind === 'answer');
  const gap = blocks.some(block => block.kind === 'gap');
  protocol(answer || gap, 'MISSING_ANSWER_OR_GAP');
  return answer ? gap ? 'partial' : 'supported' : 'insufficient_evidence';
}
/** Explicit quality labels only. Unknown metadata implies no note. */
const QUALITY_NOTES: Readonly<Record<string, string>> = Object.freeze({
  archive_probable_asr_unverified_no_verified_speakers: '來源標記為可能的自動轉錄，內容及講者未經核實。',
  automatic_transcript_unverified_no_verified_timestamps_or_speakers: '來源標記為自動轉錄，時間戳及講者未經核實。',
  local_machine_asr_unverified_no_verified_speakers: '來源標記為機器轉錄，內容及講者未經核實。',
  third_party_ai_curated_interpretation_raw_transcripts_absent: '來源標記為第三方 AI 整理詮釋，其原始逐字稿未隨此來源提供。',
  third_party_course_summary_unverified: '來源標記為未經核實的第三方課程摘要。',
  website_body_extract_unverified_may_include_comments: '來源標記為未經核實的網頁內文擷取，可能包含留言。',
  video_introduction_and_comments_not_transcript: '來源標記為影片介紹及留言，並非逐字稿。',
  partial_sampled_frame_ocr_unverified_not_transcript: '來源標記為部分抽樣畫面的未核實 OCR，並非逐字稿。',
});
export function referencedIds(blocks: readonly AnswerBlock[]): string[] {
  return [...new Set(blocks.flatMap(block => block.kind === 'gap' ? [] : block.evidenceIds))];
}
export function renderAnswer(blocks: readonly AnswerBlock[], citations: readonly Citation[]): string {
  const text = blocks.map(block => block.kind === 'gap' ? block.text : `${block.text} ${block.evidenceIds.map(id => `[${id}]`).join('')}`);
  const seen = new Set<string>();
  for (const citation of citations) {
    const note = Object.hasOwn(QUALITY_NOTES, citation.quality) ? QUALITY_NOTES[citation.quality] : undefined;
    const key = `${citation.sourceId}:${citation.sourceVersion}:${citation.quality}`;
    if (note && !seen.has(key)) { seen.add(key); text.push(`${note} [${citation.id}]`); }
  }
  return text.join('\n\n');
}
