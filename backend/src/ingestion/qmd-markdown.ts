import type { DocumentMetadata } from '@tobilu/qmd';
import type { Passage, Source } from '../domain/contracts.js';
import { ClecError } from '../domain/errors.js';
import { normalizeForSearch } from '../search/normalize.js';
import { validDate } from '../domain/date.js';

/** Stable source metadata only. Generation is the collection route, never part
 * of content-addressed Markdown, so unchanged vectors can cross generations. */
export function passageMarkdown(source: Source, passage: Passage, original: string): string {
  const metadata: DocumentMetadata = { sourceId: source.id, sourceType: source.type, sourceVersion: source.version,
    ...(source.date === undefined ? {} : { date: source.date }), ...(source.dateBasis === undefined ? {} : { dateBasis: source.dateBasis }) };
  if (!/^[a-f0-9]{64}$/.test(source.id) || !/^[a-f0-9]{64}$/.test(source.version) ||
      (source.date !== undefined && (!validDate(source.date) || !source.dateBasis)) ||
      Object.values(metadata).some(value => typeof value !== 'string' || value.length > 1024)) throw new ClecError('INVALID_METADATA', 'Source metadata cannot be represented in QMD typed frontmatter.');
  // JSON scalar quoting is valid YAML and keeps dates/IDs strings, including
  // source-controlled linebreaks and YAML punctuation without interpolation.
  const fields = Object.entries(metadata).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`).join('\n');
  return `---\nqmd:\n  metadata:\n${fields}\n---\n# ${normalizeForSearch(source.title).replace(/[\r\n]/g, ' ')}\n\nQuality: ${source.quality.replace(/[\r\n]/g, ' ')}\n\n${normalizeForSearch(original.slice(passage.start, passage.end))}\n`;
}
