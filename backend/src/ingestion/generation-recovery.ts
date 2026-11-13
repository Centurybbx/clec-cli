import { copyFile, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { checkAbort, ClecError } from '../domain/errors.js';
import { hash } from '../domain/hash.js';
import { CHECKPOINT, atomicWrite, canonical, identityKey, loadCheckpoint, recoveryFailure, settleUnknown, remainingBudget,
  syncDirectory, writeCheckpoint, type EmbeddingCheckpoint, type RecoveryIdentity } from './embedding-checkpoint.js';
import { regularFile, verifyGenerationArtifacts } from './generation-identity.js';
import { durableBackup } from './sqlite-backup.js';

const INTENT = '.embedding-recovery.json';
export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}
async function checkedCopy(source: string, target: string): Promise<void> {
  await regularFile(source);
  const before = hash(await readFile(source));
  await copyFile(source, target);
  if (hash(await readFile(target)) !== before || hash(await readFile(source)) !== before) recoveryFailure('Recovery file copy changed bytes.');
  const file = await open(target, 'r');
  try { await file.sync(); } finally { await file.close(); }
}
interface ExchangeIntent { schemaVersion: 1; generationId: string; identityKey: string; clone: string; retained: string; checkpointHash: string; donorCheckpointHash: string }
async function finishExchange(root: string, expected: RecoveryIdentity, intent: ExchangeIntent, signal: AbortSignal): Promise<void> {
  const id = expected.generationId;
  const current = join(root, id), clone = join(root, intent.clone), retained = join(root, intent.retained);
  const present = [await exists(current), await exists(clone), await exists(retained)].map(Number).join('');
  if (!['110', '011', '101'].includes(present)) recoveryFailure('Recovery exchange layout is ambiguous; all artifacts retained.');
  const donor = present === '110' ? current : retained;
  await regularFile(join(donor, CHECKPOINT));
  if (hash(await readFile(join(donor, CHECKPOINT))) !== intent.donorCheckpointHash) recoveryFailure('Recovery donor checkpoint changed.');
  const candidate = present === '101' ? current : clone;
  await regularFile(join(candidate, CHECKPOINT));
  if (hash(await readFile(join(candidate, CHECKPOINT))) !== intent.checkpointHash) recoveryFailure('Recovery clone checkpoint changed.');
  const cp = await loadCheckpoint(candidate, expected);
  if (!['embedding', 'closed'].includes(cp.phase)) recoveryFailure('Recovery candidate is not resumable.');
  for (const path of [donor, candidate]) {
    if (await exists(join(path, 'READY'))) recoveryFailure('Recovery exchange encountered READY; publication requires manual inspection.');
    await verifyGenerationArtifacts(path, expected, signal);
    await regularFile(join(path, 'qmd.sqlite'));
  }
  checkAbort(signal);
  if (present === '110') { await rename(current, retained); await syncDirectory(root); }
  if (present !== '101') { await rename(clone, current); await syncDirectory(root); }
  await unlink(join(root, INTENT));
  await syncDirectory(root);
}
/** Resolve an interrupted two-rename swap before considering another attempt. */
export async function recoverExchange(root: string, expected: RecoveryIdentity, signal: AbortSignal): Promise<void> {
  if (!await exists(join(root, INTENT))) return;
  await regularFile(join(root, INTENT));
  let value: unknown;
  try { value = JSON.parse(await readFile(join(root, INTENT), 'utf8')); } catch { recoveryFailure('Recovery exchange intent is corrupt.'); }
  const intent = value as ExchangeIntent;
  const uuid = '[a-f0-9-]{36}';
  if (!intent || typeof intent !== 'object' || canonical(Object.keys(intent).sort()) !== canonical(['schemaVersion', 'generationId', 'identityKey', 'clone', 'retained', 'checkpointHash', 'donorCheckpointHash'].sort()) ||
      intent.schemaVersion !== 1 || intent.generationId !== expected.generationId || intent.identityKey !== identityKey(expected) ||
      !new RegExp(`^\\.resume-${expected.generationId}-${uuid}$`).test(intent.clone) ||
      !new RegExp(`^\\.donor-${expected.generationId}-${uuid}$`).test(intent.retained) ||
      !/^[a-f0-9]{64}$/.test(intent.checkpointHash) || !/^[a-f0-9]{64}$/.test(intent.donorCheckpointHash)) recoveryFailure('Recovery exchange identity or paths are unknown.');
  await finishExchange(root, expected, intent, signal);
}
/** Called only while holding BUILD.lock. Donor databases are opened readOnly for public backup. */
export async function cloneForRecovery(root: string, expected: RecoveryIdentity, signal: AbortSignal): Promise<EmbeddingCheckpoint> {
  const id = expected.generationId, donor = join(root, id);
  if (await exists(join(donor, 'READY'))) recoveryFailure('READY generation cannot be a recovery donor.');
  await regularFile(join(donor, CHECKPOINT));
  const checkpoint = await loadCheckpoint(donor, expected);
  if (!['embedding', 'closed'].includes(checkpoint.phase)) recoveryFailure('Prepared-only checkpoint cannot resume QMD update. Original retained.');
  settleUnknown(checkpoint);
  if (remainingBudget(checkpoint) <= 0) throw new ClecError('EMBEDDING_BUDGET_EXHAUSTED', 'Inherited embedding time budget is exhausted; donor retained.');
  await verifyGenerationArtifacts(donor, expected, signal);
  const cloneName = `.resume-${id}-${randomUUID()}`, clone = join(root, cloneName);
  await mkdir(clone);
  await mkdir(join(clone, 'markdown'));
  for (const item of expected.markdown) {
    checkAbort(signal);
    await checkedCopy(join(donor, 'markdown', item.path), join(clone, 'markdown', item.path));
  }
  for (const name of ['evidence.sqlite', 'qmd.sqlite']) { checkAbort(signal); await durableBackup(join(donor, name), join(clone, name)); }
  for (const name of ['index.yml']) await checkedCopy(join(donor, name), join(clone, name));
  await writeCheckpoint(clone, checkpoint);
  await syncDirectory(join(clone, 'markdown'));
  await syncDirectory(clone);
  await syncDirectory(root);
  await verifyGenerationArtifacts(clone, expected, signal);
  const intent: ExchangeIntent = { schemaVersion: 1, generationId: id, identityKey: identityKey(expected), clone: cloneName,
    retained: `.donor-${id}-${randomUUID()}`, checkpointHash: hash(await readFile(join(clone, CHECKPOINT))),
    donorCheckpointHash: hash(await readFile(join(donor, CHECKPOINT))) };
  await atomicWrite(root, INTENT, JSON.stringify(intent, null, 2) + '\n');
  await finishExchange(root, expected, intent, signal);
  return checkpoint;
}
