import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, rename, rm, mkdir, readdir, stat, statfs, lstat } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClecError, parseManifest, remoteUrl, isHash, RESERVE } from './contracts.js';
import { Corpus } from './corpus.js';
export const defaultDataDir = (): string => process.env.CLEC_DATA_DIR ?? join(homedir(), '.local', 'share', 'clec');
const managed = (name: string): boolean => /^[a-f0-9]{64}\.sqlite$/.test(name) || name === '.incoming.sqlite' || name === '.current.tmp';
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory()) throw new ClecError('INVALID_DATA_DIR', 'Data directory must be a directory.');
}
async function pointer(directory: string): Promise<string> {
  let release: string;
  try { release = (await readFile(join(directory, 'current'), 'utf8')).trim(); }
  catch (error) { if (missing(error)) throw new ClecError('NO_DATA', 'Run clec sync --manifest PATH first.'); throw error; }
  if (!isHash(release)) throw new ClecError('INVALID_PACKAGE', 'Invalid current pointer.');
  return release;
}
export async function openCurrent(directory: string, release?: string): Promise<Corpus> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await pointer(directory);
    if (release && release !== current) throw new ClecError('VERSION_UNAVAILABLE', 'Reference belongs to an unavailable release.');
    const path = join(directory, `${current}.sqlite`);
    try {
      if (!(await lstat(path)).isFile()) throw new ClecError('INVALID_PACKAGE', 'Managed corpus must be a regular file.');
      return new Corpus(path, current);
    } catch (error) {
      // SQLite reports its own CANTOPEN code, so establish disappearance via filesystem.
      try { await stat(path); } catch (check) {
        if (missing(check)) { if (release) throw new ClecError('VERSION_UNAVAILABLE', 'Reference release was removed during activation.'); continue; }
      }
      throw error;
    }
  }
  throw new ClecError('BUSY', 'Corpus changed repeatedly; retry command.');
}
export async function managedBytes(directory: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(directory)) if (managed(name) || name === 'current' || name === '.sync.lock' || name === '.sync.recovery') {
    try { total += (await lstat(join(directory, name))).size; } catch (error) { if (!missing(error)) throw error; }
  }
  return total;
}
function location(value: string): URL | string {
  if (/^[A-Za-z]:[\\/]/.test(value) || !/^[a-z][a-z0-9+.-]*:/i.test(value)) return resolve(value);
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ClecError('INVALID_URL', 'Invalid manifest location.'); }
  if (url.username || url.password || url.href.includes('#')) throw new ClecError('INVALID_URL', 'Credentials and URL fragments are unsupported.');
  if (url.protocol === 'file:') return fileURLToPath(url);
  return remoteUrl(value);
}
async function stream(input: URL | string, maximum: number, consume: (chunk: Buffer) => Promise<void>): Promise<{ bytes: number; location: URL | string }> {
  let effectiveLocation = input;
  let size = 0;
  const accept = async (value: Uint8Array): Promise<void> => { size += value.byteLength; if (size > maximum) throw new ClecError('TRANSFER_TOO_LARGE', 'Transfer exceeds declared size.'); await consume(Buffer.from(value)); };
  if (typeof input === 'string') {
    const source = createReadStream(input); for await (const chunk of source) await accept(chunk);
  } else {
    let target = input;
    let response: Response | undefined;
    const signal = AbortSignal.timeout(300_000);
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await fetch(target, { redirect: 'manual', signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const next = response.headers.get('location'); await response.body?.cancel();
      if (!next || redirects === 5) throw new ClecError('TRANSFER_FAILED', 'Missing redirect location or redirect limit exceeded.');
      let redirect: URL;
      try { redirect = new URL(next, target); }
      catch { throw new ClecError('INVALID_URL', 'Invalid redirect location.'); }
      const checked = remoteUrl(redirect.href);
      if (target.protocol === 'https:' && checked.protocol !== 'https:') throw new ClecError('INVALID_URL', 'Redirect protocol downgrade is unsupported.');
      target = checked;
    }
    effectiveLocation = target;
    if (!response || !response.ok || !response.body) throw new ClecError('TRANSFER_FAILED', `HTTP ${response?.status ?? 'unavailable'}.`);
    const length = response.headers.get('content-length'); if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) { await response.body.cancel(); throw new ClecError('TRANSFER_TOO_LARGE', 'HTTP content length exceeds limit.'); }
    const reader = response.body.getReader();
    try { for (;;) { const next = await reader.read(); if (next.done) break; await accept(next.value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  return { bytes: size, location: effectiveLocation };
}
async function acquire(directory: string): Promise<() => Promise<void>> {
  const path = join(directory, '.sync.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600); const token = randomUUID();
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token })); await handle.close();
      return async () => { await rm(path, { force: true }); };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const recoveryPath = join(directory, '.sync.recovery');
      let recovery;
      try { recovery = await open(recoveryPath, 'wx', 0o600); }
      catch { throw new ClecError('SYNC_LOCKED', 'Lock recovery is already in progress; confirm no sync process is running, then remove .sync.recovery to recover.'); }
      try {
        let dead = false;
        try {
          const owner: unknown = JSON.parse(await readFile(path, 'utf8'));
          if (owner && typeof owner === 'object' && 'host' in owner && owner.host === hostname() && 'pid' in owner && typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); } catch (check) { dead = check instanceof Error && 'code' in check && check.code === 'ESRCH'; }
          }
        } catch {}
        if (!dead) throw new ClecError('SYNC_LOCKED', 'Another sync owns this data directory; stale owner must be proven gone.');
        await rm(path);
      } finally { await recovery.close(); await rm(recoveryPath, { force: true }); }
    }
  }
  throw new ClecError('SYNC_LOCKED', 'Could not acquire sync lock.');
}
async function cleanup(directory: string, active: string | undefined): Promise<void> {
  for (const name of await readdir(directory)) if (managed(name) && name !== `${active}.sqlite`) {
    try { await rm(join(directory, name)); } catch { throw new ClecError('CLEANUP_BLOCKED', 'Obsolete managed file could not be removed; close readers and retry sync.'); }
  }
}
export async function sync(directory: string, manifestLocation: string): Promise<object> {
  await ensureDirectory(directory); const releaseLock = await acquire(directory);
  try {
    let active: string | undefined; try { active = await pointer(directory); } catch (error) { if (!(error instanceof ClecError && error.code === 'NO_DATA')) throw error; }
    await cleanup(directory, active);
    const input = location(manifestLocation); const chunks: Buffer[] = [];
    const transferredManifest = await stream(input, 64 * 1024, async chunk => { chunks.push(chunk); });
    const manifest = parseManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const manifestBase = transferredManifest.location;
    const artifact = typeof manifestBase === 'string' ? join(dirname(manifestBase), manifest.artifact) : remoteUrl(manifest.artifactUrl ?? new URL(manifest.artifact, manifestBase).href);
    if (manifestBase instanceof URL && artifact instanceof URL && manifestBase.protocol === 'https:' && artifact.protocol !== 'https:') throw new ClecError('INVALID_URL', 'Artifact protocol downgrade is unsupported.');
    if (active === manifest.sha256) {
      const local = join(directory, `${active}.sqlite`);
      const digest = createHash('sha256');
      try {
        if ((await stat(local)).size === manifest.bytes) {
          for await (const chunk of createReadStream(local)) digest.update(chunk);
          if (digest.digest('hex') === active) {
            const corpus = new Corpus(local, active);
            try {
              const counts = corpus.counts();
              if (JSON.stringify(counts) !== JSON.stringify(manifest.counts)) throw new ClecError('INVALID_PACKAGE', 'Release counts mismatch.');
              return { release: active, counts, managedBytes: await managedBytes(directory), reused: true };
            } finally { corpus.close(); }
          }
        }
      } catch (error) { if (error instanceof ClecError && error.code === 'INVALID_PACKAGE') throw error; }
    }
    const space = await statfs(directory); if (space.bavail * space.bsize < manifest.bytes + RESERVE) throw new ClecError('INSUFFICIENT_SPACE', 'Incoming artifact plus 5 GiB reserve required.');
    const candidate = join(directory, '.incoming.sqlite'); const handle = await open(candidate, 'wx', 0o600); const digest = createHash('sha256');
    let bytes = 0;
    try {
      const transfer = await stream(artifact, manifest.bytes, async chunk => { digest.update(chunk); await handle.writeFile(chunk); });
      bytes = transfer.bytes;
      await handle.sync();
    } finally { await handle.close(); }
    if (bytes !== manifest.bytes || digest.digest('hex') !== manifest.sha256) throw new ClecError('INTEGRITY_MISMATCH', 'Artifact length or SHA-256 mismatch.');
    const corpus = new Corpus(candidate, manifest.sha256); try { corpus.validate(manifest); } finally { corpus.close(); }
    if (active === manifest.sha256) { await rename(candidate, join(directory, `${active}.sqlite`)); return { release: active, counts: manifest.counts, managedBytes: await managedBytes(directory), repaired: true }; }
    await rename(candidate, join(directory, `${manifest.sha256}.sqlite`));
    const next = join(directory, '.current.tmp'); await writePointer(next, manifest.sha256);
    await rename(next, join(directory, 'current'));
    let cleanupPending = false;
    try { await cleanup(directory, manifest.sha256); } catch (error) { if (!(error instanceof ClecError && error.code === 'CLEANUP_BLOCKED')) throw error; cleanupPending = true; }
    return { release: manifest.sha256, counts: manifest.counts, managedBytes: await managedBytes(directory), cleanupPending };
  } finally { await rm(join(directory, '.incoming.sqlite'), { force: true }); await rm(join(directory, '.current.tmp'), { force: true }); await releaseLock(); }
}
async function writePointer(path: string, release: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600); try { await handle.writeFile(release + '\n'); await handle.sync(); } finally { await handle.close(); }
}
