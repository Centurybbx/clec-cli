import { ClecError } from './errors.js';
import { validDate } from './date.js';
import type { SourceType } from './contracts.js';
export interface SearchFilter { sourceIds?: string[]; types?: SourceType[]; dateFrom?: string; dateTo?: string }
const types = new Set(['document', 'qa', 'transcript', 'curated', 'metadata']);
/** Shared external boundary: canonical field/key order and sorted set values. */
export function validateSearchFilter(input: unknown): SearchFilter {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['sourceIds', 'types', 'dateFrom', 'dateTo'].includes(k))) throw new ClecError('INVALID_FILTER', 'Unknown search scope.');
  const filter = input as Record<string, unknown>;
  for (const key of ['sourceIds', 'types'] as const) {
    const values = filter[key];
    if (values !== undefined && (!Array.isArray(values) || values.length > 64 || values.some(v => typeof v !== 'string' || (key === 'sourceIds' ? !/^[a-f0-9]{64}$/.test(v) : !types.has(v))))) throw new ClecError('INVALID_FILTER', `Invalid ${key}; at most 64 values are allowed.`);
  }
  for (const date of [filter.dateFrom, filter.dateTo]) if (date !== undefined && (typeof date !== 'string' || !validDate(date))) throw new ClecError('INVALID_FILTER', 'Date bounds must be real YYYY-MM-DD dates.');
  const typed = input as SearchFilter;
  if (typed.dateFrom && typed.dateTo && typed.dateFrom > typed.dateTo) throw new ClecError('INVALID_FILTER', 'Date range is reversed.');
  return { ...(typed.sourceIds === undefined ? {} : { sourceIds: [...new Set(typed.sourceIds)].sort() }),
    ...(typed.types === undefined ? {} : { types: [...new Set(typed.types)].sort() }),
    ...(typed.dateFrom === undefined ? {} : { dateFrom: typed.dateFrom }), ...(typed.dateTo === undefined ? {} : { dateTo: typed.dateTo }) };
}
