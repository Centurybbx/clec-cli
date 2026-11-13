/** Static release inventory only: no imports or execution of application/QMD. */
import { createHash } from 'node:crypto';
import { readdir, readFile, readlink, lstat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(join(backend, directory), { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile() || entry.isSymbolicLink()) result.push(path);
  }
  return result.sort();
}
const pkg = JSON.parse(await readFile(join(backend, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(backend, 'package-lock.json'), 'utf8'));
const qmd = lock.packages['node_modules/@tobilu/qmd'];
if (qmd.resolved !== pkg.dependencies['@tobilu/qmd'] || !/^git\+https:\/\/github\.com\/tobi\/qmd\.git#[a-f0-9]{40}$/.test(qmd.resolved)) throw new Error('QMD manifest/lock must agree on the full official HTTPS commit pin.');
const paths = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.installer.json',
  ...await files('src'), ...await files('dist'), ...await files('scripts'), ...await files('patches'),
  ...await files('node_modules')];
const records = [];
for (const path of paths.sort()) {
  const absolute = join(backend, path);
  if ((await lstat(absolute)).isSymbolicLink()) {
    const target = await readlink(absolute);
    records.push({ path: `backend/${path}`, kind: 'symlink', target, bytes: Buffer.byteLength(target), sha256: digest(target) });
  } else {
    const bytes = await readFile(absolute);
    records.push({ path: `backend/${path}`, kind: 'file', bytes: bytes.byteLength, sha256: digest(bytes) });
  }
}
const output = process.argv[2];
if (!output) throw new Error('Usage: node scripts/artifact-manifest.ts <output.json>');
await writeFile(resolve(output), JSON.stringify({ schemaVersion: 2, createdAt: new Date().toISOString(),
  purpose: 'Static implementation/build inventory; no runtime acceptance claim.', node: process.versions.node,
  platform: process.platform, arch: process.arch, packageManager: pkg.packageManager,
  qmd: { version: qmd.version, resolved: qmd.resolved, integrity: qmd.integrity,
    buildInfo: JSON.parse(await readFile(join(backend, 'node_modules/@tobilu/qmd/dist/cli/build-info.json'), 'utf8')) },
  scope: 'All regular files and symlink targets under backend/src, dist, scripts, patches, node_modules plus package/lock and both tsconfigs. Symlinks are not traversed; their target text is hashed. No state, credentials, models outside node_modules, corpus or evaluation inputs.',
  recordCount: records.length, fileCount: records.filter(record => record.kind === 'file').length,
  symlinkCount: records.filter(record => record.kind === 'symlink').length,
  inventorySha256: digest(JSON.stringify(records)), files: records }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output: resolve(output), recordCount: records.length, inventorySha256: digest(JSON.stringify(records)) }));
