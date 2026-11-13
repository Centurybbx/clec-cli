export type SourceType = 'document' | 'qa' | 'transcript' | 'curated' | 'metadata';
export type IntakeStatus = 'ready' | 'quarantined' | 'unsupported' | 'metadata_only';
export interface IntakeSource {
  path: string; title: string; type: SourceType; quality: string; status: IntakeStatus;
  date?: string; dateBasis?: string; origin?: string;
}
export interface IntakeManifest { schemaVersion: 1; sources: IntakeSource[] }
export interface Source extends Omit<IntakeSource, 'date' | 'dateBasis'> {
  id: string; version: string; contentHash: string; date: string | undefined;
  dateBasis: string | undefined;
}
export interface Section {
  id: string; sourceId: string; sourceVersion: string; order: number;
  start: number; end: number; boundary: 'whole' | 'heading' | 'contiguous';
}
export interface Passage {
  id: string; sectionId: string; sourceId: string; sourceVersion: string; start: number; end: number;
}
export interface InventoryEntry { path: string; status: string; reason: string; contentHash?: string }
export interface Generation {
  id: string; createdAt: string; collection: string; manifestHash: string;
  sourceCount: number; sectionCount: number; inventory: InventoryEntry[];
  intakeSourceCount: number; readySelectedSourceCount: number;
  intakePath: string; intakeFileHash: string;
  searchMode: 'lexical' | 'hybrid'; segmentationRevision: string;
}
export interface Candidate {
  passage: Passage; source: Source; score: number;
  /** Untrusted navigation from exact original spans; never a read/citation. */
  navigation?: { start: number; end: number; text: string };
}
export interface Citation {
  id: string; generation: string; sourceId: string; sourceVersion: string; sectionId: string;
  start: number; end: number; quote: string; title: string; path: string;
  quality: string; date: string | undefined; dateBasis: string | undefined;
}
export interface EvidenceRead { citation: Citation; section: Section }
export type QaEvent =
  | { type: 'start'; runId: string; generation: string }
  | { type: 'search'; query: string; supplementary: boolean; candidates: Candidate[] }
  | { type: 'read'; citations: Citation[] }
  | { type: 'text'; text: string }
  | { type: 'citation'; citation: Citation }
  | { type: 'complete'; runId: string; metrics: Record<string, number>; answerability: import('./answer.js').Answerability; blocks: import('./answer.js').AnswerBlock[] }
  | { type: 'error'; runId: string; code: string; message: string };
export type Emit = (event: QaEvent) => void;
