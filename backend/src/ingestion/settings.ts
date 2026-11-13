import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '../domain/hash.js';
import { checkAbort, ClecError } from '../domain/errors.js';
import { SEGMENTATION_REVISION } from './sections.js';
import { EMBEDDING_REVISION, embeddingPolicy, type EmbeddingPolicy } from './embedding-policy.js';

export const NORMALIZATION_REVISION = 'nfkc-opencc-js-1.0.5-tw-cn-v1';
export const QMD_COMMIT = '86d2365d17fc682e491c2c53d1e4a884aee8682a';
export interface BuildSettings {
  segmentationRevision: string;
  normalizationRevision: string;
  markdownRevision: string;
  embeddingRevision: string;
  embeddingPolicy: EmbeddingPolicy;
  qmdVersion: string;
  qmdCommit: string;
  qmdPatchHash: string;
  qmdBuildHashes: Record<string, string>;
  runtime: { node: string; platform: string; arch: string; llamaCppVersion: string };
  searchMode: 'lexical' | 'hybrid';
  models: { embed: string; rerank: string; generate: string };
  localModelHashes: Record<string, string>;
}
async function packageVersion(entry: string): Promise<string> {
  const path = resolve(dirname(fileURLToPath(import.meta.resolve(entry))), '..', 'package.json');
  return (JSON.parse(await readFile(path, 'utf8')) as { version: string }).version;
}
async function qmdBuildHashes(signal: AbortSignal): Promise<Record<string, string>> {
  const qmdDist = dirname(fileURLToPath(import.meta.resolve('@tobilu/qmd')));
  const hashes: Record<string, string> = {};
  for (const file of ['index.js', 'index.d.ts', 'store.js', 'store.d.ts', 'llm.js', 'metadata-filter.js', 'metadata.js']) {
    checkAbort(signal); hashes[file] = hash(await readFile(resolve(qmdDist, file)));
  }
  hashes['patch-inventory'] = hash(await readFile(new URL('../../patches/qmd-artifacts.json', import.meta.url)));
  return hashes;
}
/** Serving must never migrate an old published QMD DB with another runtime.
 * Local GGUF byte verification happens once at CLI startup, never per query. */
export async function verifyServingSettings(settings: BuildSettings | undefined, signal: AbortSignal): Promise<void> {
  if (!settings || settings.qmdCommit !== QMD_COMMIT || settings.markdownRevision !== 'qmd-typed-metadata-stable-v2' ||
    settings.qmdVersion !== await packageVersion('@tobilu/qmd') ||
    JSON.stringify(settings.qmdBuildHashes) !== JSON.stringify(await qmdBuildHashes(signal)) ||
    settings.runtime.node !== process.versions.node || settings.runtime.platform !== process.platform || settings.runtime.arch !== process.arch ||
    settings.runtime.llamaCppVersion !== await packageVersion('node-llama-cpp')) throw new ClecError('INDEX_MISMATCH', 'Generation runtime does not match installed pinned QMD. Rebuild before serving.');
  for (const role of ['embed', 'rerank', 'generate'] as const) {
    const expected = settings.localModelHashes[role];
    if (settings.models[role].startsWith('hf:')) continue;
    if (!expected) throw new ClecError('INDEX_MISMATCH', 'Local model hash is missing.');
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(settings.models[role], { signal })) { checkAbort(signal); digest.update(chunk); }
    if (digest.digest('hex') !== expected) throw new ClecError('INDEX_MISMATCH', 'Local model bytes changed since ingestion. Restore the pinned file or rebuild.');
  }
}
/** Pin a multilingual embedding default and explicit upstream query/rerank defaults. */
export async function buildSettings(hybrid: boolean, signal: AbortSignal): Promise<BuildSettings> {
  const models = {
    embed: process.env.QMD_EMBED_MODEL || 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf',
    rerank: process.env.QMD_RERANK_MODEL || 'hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf',
    generate: process.env.QMD_GENERATE_MODEL || 'hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf',
  };
  const localModelHashes: Record<string, string> = {};
  for (const role of ['embed', 'rerank', 'generate'] as const) {
    checkAbort(signal);
    if (models[role].startsWith('hf:')) continue;
    const path = resolve(models[role]);
    models[role] = path;
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path, { signal })) { checkAbort(signal); digest.update(chunk); }
    localModelHashes[role] = digest.digest('hex');
  }
  return { segmentationRevision: SEGMENTATION_REVISION, normalizationRevision: NORMALIZATION_REVISION,
    markdownRevision: 'qmd-typed-metadata-stable-v2', embeddingRevision: EMBEDDING_REVISION, embeddingPolicy: embeddingPolicy(), qmdVersion: await packageVersion('@tobilu/qmd'), qmdCommit: QMD_COMMIT, qmdBuildHashes: await qmdBuildHashes(signal), qmdPatchHash: hash(await readFile(new URL('../../patches/@tobilu+qmd+2.8.3.patch', import.meta.url))),
    runtime: { node: process.versions.node, platform: process.platform, arch: process.arch, llamaCppVersion: await packageVersion('node-llama-cpp') },
    searchMode: hybrid ? 'hybrid' : 'lexical', models, localModelHashes };
}
export const settingsKey = (settings: BuildSettings): string => hash(JSON.stringify(settings));
/** Text-derived reuse is independent of model/runtime changes. */
export const textSettingsKey = (settings: BuildSettings): string => hash(JSON.stringify([settings.segmentationRevision, settings.normalizationRevision, settings.markdownRevision]));
