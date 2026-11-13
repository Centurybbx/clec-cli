import { basename } from 'node:path';
import type { Source } from '../domain/contracts.js';
import { normalizeForSearch } from './normalize.js';
import { validateSearchFilter, type SearchFilter } from './filters.js';

/** Resolve only explicit episode syntax, exact filenames or quoted full titles
 * against real metadata. Bare years/fund numbers never implicitly scope a query. */
export function resolveSourceScope(query: string, sources: Source[], requested: SearchFilter = {}, priorQuery?: string): SearchFilter {
  const filter = validateSearchFilter(requested);
  // Current explicit source selection wins over history. The service supplies
  // at most the most recent genuine user question, only for anaphoric turns.
  // Never union episode identifiers from a concatenated retrieval query.
  for (const input of [query, ...(priorQuery ? [priorQuery] : [])]) {
    const canonical = normalizeForSearch(input).toLowerCase();
    const episodes = [...canonical.matchAll(/(?:第\s*(\d{1,8})\s*(?:集|期)|\b(?:ep(?:isode)?)[.\s#-]*(\d{1,8})\b)/g)].map(m => Number(m[1] ?? m[2]));
    const episodeKey = (value: string): string | undefined => {
      const match = /^(short|ep|chat)-(\d+)([a-z]?)$/i.exec(value);
      return match ? `${match[1]!.toLowerCase()}:${Number(match[2])}:${match[3]!.toLowerCase()}` : undefined;
    };
    const codes = (canonical.match(/\b(?:short|ep|chat)-\d+[a-z]?\b/g) ?? []).map(value => episodeKey(value));
    const titles = [...canonical.matchAll(/[「『《“"]([^」』》”"]+)[」』》”"]/g)].map(m => m[1]!.trim());
    const queryNames = new Set(canonical.split(/[\s「」『』《》“”"，。？！,?!]+/));
    let recognized = episodes.length > 0 || codes.length > 0;
    const matched: string[] = [];
    for (const source of sources) {
      const title = normalizeForSearch(source.title).toLowerCase();
      const filename = normalizeForSearch(basename(source.path)).toLowerCase();
      // Only the collected family's actual episode identifier grammar. A date in
      // an arbitrary document/archive filename is never an episode identifier.
      let episodeId: string | undefined;
      if (source.origin) {
        try {
          const origin = new URL(source.origin);
          if (origin.hostname === 'clectw.com' && origin.protocol === 'https:') episodeId = /^\/ep\/((?:short|ep|chat)-\d+[a-z]?)\/?$/i.exec(origin.pathname)?.[1];
        } catch { /* A local provenance path is not a canonical episode URL. */ }
      }
      episodeId ??= /^collection\/web\/clectw\/transcripts\/((?:short|ep|chat)-\d+[a-z]?)\.txt$/i.exec(source.path)?.[1];
      const episodeNumber = episodeId ? Number(/-(\d+)/.exec(episodeId)![1]) : undefined;
      const exactName = queryNames.has(filename);
      const exactTitle = titles.includes(title) && title.length >= 4;
      if (exactName || exactTitle) recognized = true;
      if (exactName || exactTitle || episodes.includes(episodeNumber!) || (episodeId !== undefined && codes.includes(episodeKey(episodeId)))) matched.push(source.id);
    }
    if (!recognized) continue;
    // Do not silently broaden the explicit caller's scope. An unresolved episode
    // is empty scope; a title only scopes when actually present in the catalogue.
    return { ...filter, sourceIds: matched.filter(id => !filter.sourceIds || filter.sourceIds.includes(id)) };
  }
  return filter;
}
