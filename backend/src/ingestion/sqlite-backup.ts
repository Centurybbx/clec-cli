import { DatabaseSync, backup } from 'node:sqlite';
import { lstat, open } from 'node:fs/promises';
import { ClecError } from '../domain/errors.js';

/** Public coherent backup includes committed WAL pages. No hardlinks or private SQL. */
export async function durableBackup(source: string, target: string): Promise<void> {
  if (!(await lstat(source)).isFile()) throw new ClecError('RECOVERY_REFUSED', 'Backup source must be a regular file.');
  const db = new DatabaseSync(source, { readOnly: true });
  let failed = false;
  try { await backup(db, target); } catch (error) { failed = true; throw error; }
  finally { try { db.close(); } catch (error) { if (!failed) throw error; } }
  const file = await open(target, 'r');
  try { await file.sync(); } finally { await file.close(); }
}
