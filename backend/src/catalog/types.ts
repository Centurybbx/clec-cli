import type { IntakeManifest, IntakeSource } from '../domain/contracts.js';

export type RecordData = Record<string, unknown>;
export type CoverageCategory = 'ready' | 'quarantined' | 'unsupported' | 'metadata_only' | 'excluded' | 'missing' | 'empty' | 'error';
export interface RecordReference { file: string; record: number }
export interface CatalogueEntry {
  id: string;
  family: string;
  reference: RecordReference;
  path?: string;
  title: string;
  category: CoverageCategory;
  reason: string;
  source?: IntakeSource;
  contentHash?: string;
  selected: boolean;
  /** Exact manifest record, including archive members, hashes, acquisition state and timing disclaimers. */
  provenance: RecordData;
}
export interface CatalogueRelationship {
  from: string;
  to: string;
  kind: 'extracted_from' | 'representation_of' | 'retry_of' | 'same_path' | 'candidate_match';
  verified: boolean;
  basis: string;
}
export interface CatalogueIssue { file: string; record?: number; code: string; message: string }
export interface FamilyCoverage {
  records: number;
  selectedSources: number;
  categories: Record<CoverageCategory, number>;
  reasons: Record<string, number>;
}
export interface CorpusCatalogue {
  schemaVersion: 1;
  manifest: IntakeManifest;
  entries: CatalogueEntry[];
  relationships: CatalogueRelationship[];
  coverage: { families: Record<string, FamilyCoverage>; total: FamilyCoverage; complete: boolean };
  issues: CatalogueIssue[];
  limitations: string[];
}
export interface Candidate {
  family: string;
  reference: RecordReference;
  record: RecordData;
  path?: string;
  title: string;
  type: IntakeSource['type'];
  quality: string;
  origin?: string;
  category?: CoverageCategory;
  reason?: string;
  expectedHash?: string;
}
