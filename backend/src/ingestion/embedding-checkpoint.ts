import { open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClecError } from '../domain/errors.js';
import { hash } from '../domain/hash.js';
import type { BuildSettings } from './settings.js';

export interface RecoveryIdentity {
  generationId: string; manifestHash: string; intakeFileHash: string;
  sourceDigest: string; evidenceDigest: string;
  markdown: Array<{ path: string; bytes: number; sha256: string }>;
  sourceCount: number; sectionCount: number; settings: BuildSettings;
  embedding: { model: string; modelHash: string; fingerprint: string; chunkStrategy: 'regex' } | null;
}
export interface PreparationMetrics {
  previousGeneration: string | null;
  reused: number; changed: number; added: number; removed: number; reprocessed: number;
  copiedMarkdown: number; generatedMarkdown: number;
}
export interface EmbeddingCheckpoint {
  schemaVersion: 1;
  phase: 'prepared' | 'embedding' | 'closed';
  identity: RecoveryIdentity;
  preparation: PreparationMetrics;
  work: {
    initialPending: number | null; remaining: number | null;
    successfulUnits: number; attempts: number; chargedMs: number;
    active: { sequence: number; reservedMs: number; pendingBefore: number | null } | null;
  };
}
export const CHECKPOINT = 'embedding-checkpoint.json';
export function recoveryFailure(message: string): never { throw new ClecError('RECOVERY_REFUSED', message); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export const identityKey = (identity: RecoveryIdentity): string => hash(canonical(identity));
export const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) recoveryFailure('Checkpoint object is malformed.');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).sort().join() !== expected.sort().join()) recoveryFailure('Unknown or missing checkpoint fields.');
}
/** Decode only versioned protocol data, never a BUILDING marker or legacy work ledger. */
export function decodeCheckpoint(bytes: string, expected: RecoveryIdentity): EmbeddingCheckpoint {
  let raw: unknown;
  try { raw = JSON.parse(bytes); } catch { recoveryFailure('Checkpoint JSON is invalid.'); }
  const cp = object(raw);
  keys(cp, ['schemaVersion', 'phase', 'identity', 'preparation', 'work']);
  if (cp.schemaVersion !== 1 || !['prepared', 'embedding', 'closed'].includes(String(cp.phase)) ||
      canonical(cp.identity) !== canonical(expected)) recoveryFailure('Checkpoint version, phase or complete identity does not match.');
  const p = object(cp.preparation);
  keys(p, ['previousGeneration', 'reused', 'changed', 'added', 'removed', 'reprocessed', 'copiedMarkdown', 'generatedMarkdown']);
  if (p.previousGeneration !== null && !digest(p.previousGeneration)) recoveryFailure('Invalid checkpoint predecessor.');
  for (const [key, value] of Object.entries(p)) if (key !== 'previousGeneration' && !nonnegative(value)) recoveryFailure('Invalid preparation metrics.');
  if (Number(p.reused) + Number(p.changed) + Number(p.added) + Number(p.reprocessed) !== expected.sourceCount ||
      Number(p.copiedMarkdown) + Number(p.generatedMarkdown) !== expected.sectionCount) recoveryFailure('Preparation counts do not cover the expected evidence.');
  const w = object(cp.work);
  keys(w, ['initialPending', 'remaining', 'successfulUnits', 'attempts', 'chargedMs', 'active']);
  for (const key of ['successfulUnits', 'attempts'] as const) if (!nonnegative(w[key])) recoveryFailure('Invalid attempt counters.');
  if (typeof w.chargedMs !== 'number' || !Number.isFinite(w.chargedMs) || w.chargedMs < 0 ||
      (w.initialPending !== null && !nonnegative(w.initialPending)) || (w.remaining !== null && !nonnegative(w.remaining)) ||
      (w.initialPending === null) !== (w.remaining === null) ||
      (typeof w.initialPending === 'number' && Number(w.remaining) > w.initialPending) || Number(w.successfulUnits) > Number(w.attempts)) recoveryFailure('Invalid checkpoint budget.');
  if (cp.phase === 'prepared' && (w.initialPending !== null || w.successfulUnits !== 0)) recoveryFailure('Prepared checkpoint contains embedding progress.');
  if (cp.phase !== 'prepared' && w.initialPending === null) recoveryFailure('Embedding checkpoint has no pending baseline.');
  if (w.active !== null) {
    const a = object(w.active);
    keys(a, ['sequence', 'reservedMs', 'pendingBefore']);
    if (a.sequence !== w.attempts || !nonnegative(a.sequence) || a.sequence === 0 || !nonnegative(a.reservedMs) || a.reservedMs === 0 ||
        a.reservedMs > expected.settings.embeddingPolicy.maxDurationMs || (a.pendingBefore !== null && !nonnegative(a.pendingBefore))) recoveryFailure('Invalid reserved attempt.');
  }
  if (cp.phase === 'closed' && (w.active !== null || w.remaining !== 0)) recoveryFailure('Closed checkpoint has unfinished work.');
  return raw as EmbeddingCheckpoint;
}
export async function syncDirectory(directory: string): Promise<void> {
  const parent = await open(directory, 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}
/** Same-directory unique temporary, file fsync, rename, parent fsync. */
export async function atomicWrite(directory: string, name: string, bytes: string): Promise<void> {
  const temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(directory, name));
    await syncDirectory(directory);
  } finally { await rm(temporary, { force: true }); }
}
export const writeCheckpoint = (directory: string, checkpoint: EmbeddingCheckpoint): Promise<void> =>
  atomicWrite(directory, CHECKPOINT, JSON.stringify(checkpoint, null, 2) + '\n');
export async function loadCheckpoint(directory: string, expected: RecoveryIdentity): Promise<EmbeddingCheckpoint> {
  let bytes: string;
  try { bytes = await readFile(join(directory, CHECKPOINT), 'utf8'); }
  catch { recoveryFailure('Existing generation has no readable versioned checkpoint; original artifacts retained.'); }
  return decodeCheckpoint(bytes, expected);
}
/** An unobserved result consumes its full durable reservation on the next recovery. */
export function settleUnknown(checkpoint: EmbeddingCheckpoint): void {
  if (checkpoint.work.active) {
    checkpoint.work.chargedMs += checkpoint.work.active.reservedMs;
    checkpoint.work.active = null;
  }
}
export function remainingBudget(checkpoint: EmbeddingCheckpoint): number {
  return Math.floor(checkpoint.identity.settings.embeddingPolicy.maxTotalDurationMs - checkpoint.work.chargedMs);
}
export async function reserveAttempt(directory: string, checkpoint: EmbeddingCheckpoint, pendingBefore: number | null): Promise<number> {
  if (checkpoint.work.active) recoveryFailure('An attempt is already active.');
  const available = remainingBudget(checkpoint);
  if (available <= 0) throw new ClecError('EMBEDDING_BUDGET_EXHAUSTED', 'Embedding build inherited its exhausted total time budget.');
  if (checkpoint.work.attempts >= Number.MAX_SAFE_INTEGER) recoveryFailure('Attempt sequence exhausted.');
  const reserved = Math.min(checkpoint.identity.settings.embeddingPolicy.maxDurationMs, available);
  checkpoint.work.attempts++;
  checkpoint.work.active = { sequence: checkpoint.work.attempts, reservedMs: reserved, pendingBefore };
  await writeCheckpoint(directory, checkpoint);
  return reserved;
}
export async function settleAttempt(directory: string, checkpoint: EmbeddingCheckpoint, elapsedMs: number): Promise<void> {
  if (!checkpoint.work.active) recoveryFailure('No reserved attempt to settle.');
  checkpoint.work.chargedMs += elapsedMs;
  checkpoint.work.active = null;
  await writeCheckpoint(directory, checkpoint);
}
