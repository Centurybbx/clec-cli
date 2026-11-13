import { resolve } from 'node:path';
import type { AppConfig } from '../config.js';
import type { GenerationLocation } from '../ingestion/generation.js';
import { ClecError, checkAbort } from '../domain/errors.js';
import { QMD_COMMIT } from '../ingestion/settings.js';
import { McpMetadataTransport } from './mcp-transport.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Public QMD 2.8.3 MCP metadata, checked against the already pinned generation.
 * No search, embedding, reranking, model call or second CURRENT resolution.
 */
export async function assertQmdGeneration(config: AppConfig, generation: GenerationLocation, callerSignal: AbortSignal): Promise<void> {
  checkAbort(callerSignal);
  if (generation.metadata.buildSettings?.qmdCommit !== QMD_COMMIT || generation.metadata.buildSettings.markdownRevision !== 'qmd-typed-metadata-stable-v2') throw new ClecError('INDEX_MISMATCH', 'Generation predates the pinned metadata retrieval contract. Rebuild before querying.');
  const signal = AbortSignal.any([AbortSignal.timeout(1500), callerSignal]);
  const transport = new McpMetadataTransport(new URL('/mcp', config.qmdUrl), signal);
  try {
    const init = await transport.initialize();
    if (!object(init.serverInfo) || init.serverInfo.name !== 'qmd' || init.serverInfo.version !== '2.8.3' ||
      !object(init.capabilities) || !object(init.capabilities.tools)) throw new Error('Incompatible QMD metadata server');
    const result = await transport.request('tools/call', { name: 'status', arguments: {} });
    const status = result.structuredContent;
    if (result.isError || !object(status) || !Array.isArray(status.collections)) throw new Error('Invalid metadata');
    const collection = status.collections.find(c => object(c) && c.name === generation.metadata.collection);
    if (!object(collection) || typeof collection.path !== 'string' ||
      resolve(collection.path) !== resolve(generation.directory, 'markdown') || collection.documents !== generation.metadata.sectionCount ||
      !Array.isArray(collection.metadataKeys) || !['sourceId', 'sourceType', 'sourceVersion'].every(key =>
        (collection.metadataKeys as unknown[]).some(entry => object(entry) && entry.key === key && entry.documents === generation.metadata.sectionCount && Array.isArray(entry.types) && entry.types.length === 1 && entry.types[0] === 'string')) ||
      (generation.metadata.searchMode === 'hybrid' && (status.hasVectorIndex !== true || status.needsEmbedding !== 0))) {
      throw new ClecError('INDEX_MISMATCH', 'QMD metadata does not match the pinned completed generation. Restart QMD for this generation.');
    }
  } catch (error) {
    checkAbort(callerSignal);
    if (error instanceof ClecError) throw error;
    throw new ClecError('SEARCH_UNAVAILABLE', 'QMD compatible generation metadata is unavailable within the bounded check.');
  } finally { await transport.close(); }
}
