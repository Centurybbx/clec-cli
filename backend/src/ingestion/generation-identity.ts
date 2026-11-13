import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getEmbeddingFingerprint } from '@tobilu/qmd';
import type { Source } from '../domain/contracts.js';
import { hash } from '../domain/hash.js';
import { checkAbort } from '../domain/errors.js';
import { EvidenceStore } from '../evidence/store.js';
import { segment } from './sections.js';
import { passageMarkdown } from './qmd-markdown.js';
import type { BuildSettings } from './settings.js';
import { canonical, recoveryFailure, type RecoveryIdentity } from './embedding-checkpoint.js';

/** Independently derive the expected evidence/Markdown identity from freshly admitted bytes. */
export function recoveryIdentity(generationId: string, manifestHash: string, intakeFileHash: string,
  admitted: Array<{ source: Source; text: string }>, settings: BuildSettings, signal: AbortSignal): RecoveryIdentity {
  const bundles: Array<{ id: string; sha256: string }> = [];
  const markdown: RecoveryIdentity['markdown'] = [];
  let sectionCount = 0;
  for (const { source, text } of admitted) {
    checkAbort(signal);
    const sections = segment(source, text);
    const passages = sections.map(s => ({ id: s.id, sectionId: s.id, sourceId: source.id, sourceVersion: source.version, start: s.start, end: s.end }));
    bundles.push({ id: source.id, sha256: hash(canonical({ source, original: text, sections, passages })) });
    sectionCount += sections.length;
    for (const passage of passages) {
      const bytes = Buffer.from(passageMarkdown(source, passage, text));
      markdown.push({ path: `${passage.id}.md`, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  if (settings.searchMode === 'hybrid' && !settings.localModelHashes.embed) recoveryFailure('Hybrid checkpoints require a verified local embedding GGUF; URI-only model identity cannot authorize recovery.');
  return { generationId, manifestHash, intakeFileHash, sourceDigest: hash(canonical(admitted.map(a => a.source).sort((a, b) => a.id.localeCompare(b.id)))),
    evidenceDigest: hash(canonical(bundles.sort((a, b) => a.id.localeCompare(b.id)))),
    markdown: markdown.sort((a, b) => a.path.localeCompare(b.path)), sourceCount: admitted.length, sectionCount, settings,
    embedding: settings.searchMode === 'hybrid' ? { model: settings.models.embed, modelHash: settings.localModelHashes.embed!,
      fingerprint: getEmbeddingFingerprint(settings.models.embed), chunkStrategy: 'regex' } : null };
}
export async function regularFile(path: string): Promise<void> {
  const item = await lstat(path);
  if (!item.isFile() || item.isSymbolicLink()) recoveryFailure('Recovery artifact is not a regular file.');
}
export async function verifyGenerationArtifacts(directory: string, expected: RecoveryIdentity, signal: AbortSignal): Promise<void> {
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) recoveryFailure('Generation directory is not a real directory.');
  const md = join(directory, 'markdown');
  if (!(await lstat(md)).isDirectory() || (await lstat(md)).isSymbolicLink()) recoveryFailure('Markdown directory is not a real directory.');
  const names = (await readdir(md)).sort();
  if (canonical(names) !== canonical(expected.markdown.map(item => item.path).sort())) recoveryFailure('Markdown evidence inventory changed.');
  for (const item of expected.markdown) {
    checkAbort(signal);
    const path = join(md, item.path);
    await regularFile(path);
    const bytes = await readFile(path);
    if (bytes.length !== item.bytes || hash(bytes) !== item.sha256) recoveryFailure('Markdown evidence bytes changed.');
  }
  await regularFile(join(directory, 'evidence.sqlite'));
  const evidence = new EvidenceStore(join(directory, 'evidence.sqlite'));
  try {
    const counts = evidence.counts();
    const bundles = evidence.sources().map(source => {
      checkAbort(signal);
      return { id: source.id, sha256: hash(canonical(evidence.exportSourceBundle(source.id))) };
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (counts.sources !== expected.sourceCount || counts.sections !== expected.sectionCount ||
        hash(canonical(bundles)) !== expected.evidenceDigest) recoveryFailure('Evidence bundles differ from current admitted source bytes/segmentation.');
  } finally { evidence.close(); }
}
