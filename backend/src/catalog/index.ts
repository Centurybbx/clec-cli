import { realpath } from 'node:fs/promises';
import type { IntakeSource } from '../domain/contracts.js';
import { CatalogueContext, compare, digest } from './context.js';
import { clectw, curatedKnowledge, driveDocuments, localDocuments, machineExtractions, metadataInventories, webManifest } from './adapters.js';
import type { CatalogueEntry, CoverageCategory, CorpusCatalogue, FamilyCoverage } from './types.js';
export type { CatalogueEntry, CatalogueIssue, CatalogueRelationship, CorpusCatalogue, CoverageCategory, FamilyCoverage, RecordReference } from './types.js';

const categories: CoverageCategory[] = ['ready', 'quarantined', 'unsupported', 'metadata_only', 'excluded', 'missing', 'empty', 'error'];
function emptyCoverage(): FamilyCoverage {
  return { records: 0, selectedSources: 0, categories: Object.fromEntries(categories.map(key => [key, 0])) as Record<CoverageCategory, number>, reasons: {} };
}
function count(coverage: FamilyCoverage, entry: CatalogueEntry): void {
  coverage.records += 1;
  coverage.selectedSources += Number(entry.selected);
  coverage.categories[entry.category] += 1;
  coverage.reasons[entry.reason] = (coverage.reasons[entry.reason] ?? 0) + 1;
}

/**
 * Read the real collection's explicit manifests and narrowly scoped knowledge/metadata trees.
 * Never writes assets, generates substitute text, calls a model, or builds a search index.
 * Manifest is safe to persist separately and pass to existing ingestion. Persist the entire
 * result alongside it: the core IntakeManifest cannot express record-level gaps/relationships.
 */
export async function catalogueCorpus(workspaceRoot: string): Promise<CorpusCatalogue> {
  if (!workspaceRoot) throw new Error('An explicit workspace root is required');
  const ctx = new CatalogueContext(await realpath(workspaceRoot));
  await localDocuments(ctx);
  await driveDocuments(ctx);
  await clectw(ctx);
  await webManifest(ctx, 'clec168');
  await webManifest(ctx, 'cfnavi');
  await curatedKnowledge(ctx);
  await machineExtractions(ctx);
  await metadataInventories(ctx);

  // Validation failures are inventory records too, so malformed manifests cannot look like an empty family.
  for (const issue of ctx.issues) {
    ctx.entries.push({ id: `catalog-issue-${digest(JSON.stringify(issue)).slice(0, 32)}`, family: 'catalogue-validation',
      reference: { file: issue.file, record: issue.record ?? 0 }, title: issue.file, category: 'error', reason: issue.code,
      selected: false, provenance: { ...issue } });
  }

  const groups = new Map<string, CatalogueEntry[]>();
  for (const entry of ctx.entries) {
    if (!entry.source) continue;
    const group = groups.get(entry.source.path) ?? [];
    group.push(entry); groups.set(entry.source.path, group);
  }
  const sources: IntakeSource[] = [];
  for (const path of [...groups.keys()].sort(compare)) {
    const group = groups.get(path)!;
    // A quarantine assertion is sticky across adapters, including quality-audit sidecars.
    const quarantine = group.filter(e => e.category === 'quarantined');
    const valid = group.filter(e => ['ready', 'metadata_only', 'unsupported'].includes(e.category));
    const pool = quarantine.length ? quarantine : valid.length ? valid : group;
    // Adapter traversal is explicit; within a manifest records are append order. Cross-file
    // conflicts are resolved by pathname/record, never filesystem mtime or current clock.
    pool.sort((a, b) => compare(a.reference.file, b.reference.file) || a.reference.record - b.reference.record || compare(a.id, b.id));
    const selected = pool[pool.length - 1]!;
    selected.selected = true;
    sources.push(selected.source!);
    for (const entry of group) {
      if (entry === selected) continue;
      const sameManifest = entry.reference.file === selected.reference.file;
      ctx.relate(entry, selected.id, sameManifest ? 'retry_of' : 'same_path', sameManifest
        ? 'latest valid append-order record for this exact path; errors retained; actual different paths are never collapsed'
        : 'same workspace path across explicit manifests; selected deterministically; all provenance retained');
      // Selection state is separate from availability: historical success/error counts remain auditable.
    }
  }
  ctx.entries.sort((a, b) => compare(a.family, b.family) || compare(a.reference.file, b.reference.file) || a.reference.record - b.reference.record || compare(a.path ?? '', b.path ?? '') || compare(a.id, b.id));
  ctx.relationships.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.kind, b.kind));
  ctx.issues.sort((a, b) => compare(a.file, b.file) || (a.record ?? 0) - (b.record ?? 0) || compare(a.code, b.code) || compare(a.message, b.message));
  const families: Record<string, FamilyCoverage> = {};
  const total = emptyCoverage();
  for (const entry of ctx.entries) {
    const family = families[entry.family] ??= emptyCoverage();
    count(family, entry); count(total, entry);
  }
  const inventory = ctx.entries.filter(entry => entry.selected && entry.path !== undefined)
    .flatMap(entry => entry.path === undefined ? [] : [{ path: entry.path, status: entry.category, reason: entry.reason }]);
  return { schemaVersion: 1, manifest: { schemaVersion: 1, sources, inventory }, entries: ctx.entries,
    relationships: ctx.relationships, coverage: { families, total, complete: false }, issues: ctx.issues,
    limitations: [
      'Coverage is of explicit collected manifests and curated knowledge, not the entire web or every original local asset. Counts are records/representations, not independent episodes.',
      'Available UTF-8 TXT/MD and SRT/STR/VTT are eligible for publishing. Subtitle syntax and cue mappings require publisher validation; ready is not proof of indexing. Binaries, remote media and metadata listings remain outside evidence text.',
      'Episode page extracts and video introductions/comments are searchable as explicitly labelled secondary or mixed material, never substituted for verified teacher speech.',
      'No content-equivalence deduplication is performed. Archive formats and candidate episode/title relationships remain distinct.',
      'Unambiguous source-title dates use source_title; declared manifest and curated frontmatter dates retain their own basis. These are not verified recording dates. Collection and modification times are never publication dates; absent or ambiguous dates remain unknown.',
      'Automatic transcripts, OCR, extracted documents, website bodies and third-party curated interpretations have not been independently verified.',
      'No timestamps or speakers are inferred from TXT. Subtitle timing remains confined to the original subtitle representation.',
      'Outside-collection summaries and evaluation material are excluded; no extraction, ASR, OCR, fetching or model calls occur.',
    ] };
}
