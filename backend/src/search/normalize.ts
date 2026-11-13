import * as OpenCC from 'opencc-js';
const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' });
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' });
export function variants(text: string): string[] {
  return [...new Set([text, toSimplified(text.normalize('NFKC')), toTraditional(text.normalize('NFKC'))])];
}
export const normalizeForSearch = (text: string): string => toSimplified(text.normalize('NFKC'));
