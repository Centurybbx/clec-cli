import * as OpenCC from 'opencc-js';
import { ClecError } from './contracts.js';
const simplify = OpenCC.Converter({ from: 'tw', to: 'cn' });
export const normalizeForSearch = (text: string): string => simplify(text.normalize('NFKC')).toLowerCase();
const encode = (prefix: string, text: string): string => prefix + Buffer.from(text).toString('hex');
function tokens(text: string, singles: boolean): string[] {
  const result: string[] = [];
  for (const match of normalizeForSearch(text).matchAll(/\p{Script=Han}+|[\p{Script=Latin}\p{N}]+/gu)) {
    const part = match[0]; const chars = [...part];
    if (/^\p{Script=Han}/u.test(part)) {
      if (singles || chars.length === 1) for (const ch of chars) result.push(encode('h', ch));
      for (let i = 0; i + 1 < chars.length; i++) result.push(encode('b', chars[i] + chars[i + 1]!));
    } else result.push(encode('l', part));
  }
  return result;
}
export const indexTokens = (text: string): string => tokens(text, true).join(' ');
export function queryTokens(query: string): string[] {
  if (!query.trim() || query.length > 512) throw new ClecError('INVALID_QUERY', 'Query needs 1..512 UTF-16 units.');
  const terms = [...new Set(tokens(query, false))];
  if (!terms.length || terms.length > 64) throw new ClecError('INVALID_QUERY', 'Query needs 1..64 lexical terms.');
  return terms;
}
