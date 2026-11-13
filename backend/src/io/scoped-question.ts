import { ClecError } from '../domain/errors.js';
import { validateSearchFilter, type SearchFilter } from '../domain/search-filter.js';

/** Shared stateless/durable CLI syntax, with original question left intact. */
export function scopedQuestion(args: string[]): { question: string; filter?: SearchFilter } {
  if (args[0] !== '--scope') return { question: args.join(' ') };
  try { return { question: args.slice(2).join(' '), filter: validateSearchFilter(JSON.parse(args[1] ?? '') as unknown) }; }
  catch (error) {
    if (error instanceof ClecError) throw error;
    throw new ClecError('INVALID_FILTER', '--scope requires a JSON scope object.');
  }
}
