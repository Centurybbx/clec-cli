import { parseMetadataFilter, type MetadataFilter } from '@tobilu/qmd';
import type { Source } from '../domain/contracts.js';
import type { SearchFilter } from '../domain/search-filter.js';
export { validateSearchFilter, type SearchFilter } from '../domain/search-filter.js';
export function eligible(source: Source, filter: SearchFilter): boolean {
  return (!filter.sourceIds || filter.sourceIds.includes(source.id)) && (!filter.types || filter.types.includes(source.type)) &&
    (!filter.dateFrom || (source.date !== undefined && source.date >= filter.dateFrom)) && (!filter.dateTo || (source.date !== undefined && source.date <= filter.dateTo));
}
/** Empty sets are handled before QMD; its AST requires nonempty membership. */
export function metadataFilter(filter: SearchFilter): MetadataFilter | undefined {
  const operands: MetadataFilter[] = [];
  if (filter.sourceIds?.length) {
    // External sets cap at 64. Authoritative natural source resolution may
    // discover more representations; split those into public bounded nodes.
    const groups: MetadataFilter[] = [];
    for (let i = 0; i < filter.sourceIds.length; i += 64) groups.push({ field: 'sourceId', operator: 'in', value: filter.sourceIds.slice(i, i + 64) });
    while (groups.length > 32) {
      const next: MetadataFilter[] = [];
      for (let i = 0; i < groups.length; i += 32) next.push({ operator: 'or', operands: groups.slice(i, i + 32) });
      groups.splice(0, groups.length, ...next);
    }
    operands.push(groups.length === 1 ? groups[0]! : { operator: 'or', operands: groups });
  }
  if (filter.types?.length) operands.push({ field: 'sourceType', operator: 'in', value: filter.types });
  if (filter.dateFrom) operands.push({ field: 'date', operator: 'gte', value: filter.dateFrom });
  if (filter.dateTo) operands.push({ field: 'date', operator: 'lte', value: filter.dateTo });
  return operands.length ? parseMetadataFilter(operands.length === 1 ? operands[0] : { operator: 'and', operands }) : undefined;
}
