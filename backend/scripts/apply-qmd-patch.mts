// Installation only: never imports QMD or initializes models/databases.
// Native Node type stripping keeps postinstall independent of devDependencies.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid QMD installation metadata.');
  return value as Record<string, unknown>;
}
const pin = 'git+https://github.com/tobi/qmd.git#86d2365d17fc682e491c2c53d1e4a884aee8682a';
const manifest = object(readJson('package.json'));
const packages = object(object(readJson('package-lock.json')).packages);
const installed = object(readJson('node_modules/@tobilu/qmd/package.json'));
if (object(manifest.dependencies)['@tobilu/qmd'] !== pin ||
    object(object(packages['']).dependencies)['@tobilu/qmd'] !== pin ||
    object(packages['node_modules/@tobilu/qmd']).resolved !== pin || installed.version !== '2.8.3') {
  throw new Error('QMD patch requires the exact reviewed git pin and package version.');
}
const patchSha256 = 'd89352ae6b8771bd1cffa931627d863395caff74587a94d5e9b915a6e74da96f';
if (createHash('sha256').update(readFileSync(resolve(root, 'patches/@tobilu+qmd+2.8.3.patch'))).digest('hex') !== patchSha256) {
  throw new Error('QMD patch bytes differ from the reviewed patch; refusing installation.');
}
const files = ['dist/index.js', 'dist/index.d.ts', 'dist/store.js', 'dist/store.d.ts'];
const artifacts = object(readJson('patches/qmd-artifacts.json'));
if (Object.keys(artifacts).sort().join() !== [...files].sort().join()) throw new Error('Invalid QMD patch artifact set.');
const reviewed = files.map(file => {
  const hashes = object(artifacts[file]);
  if (typeof hashes.before !== 'string' || typeof hashes.after !== 'string' ||
      !/^[a-f0-9]{64}$/.test(hashes.before) || !/^[a-f0-9]{64}$/.test(hashes.after)) {
    throw new Error('Invalid QMD patch artifact hashes.');
  }
  return { file, before: hashes.before, after: hashes.after };
});
const matches = (state: 'before' | 'after'): boolean => reviewed.every(artifact =>
  createHash('sha256').update(readFileSync(resolve(root, 'node_modules/@tobilu/qmd', artifact.file))).digest('hex') === artifact[state]);
// Repeated npm install is allowed only for the exact fully patched bytes.
if (matches('after')) {
  console.log('QMD patch: exact patched artifacts already installed.');
} else {
  if (!matches('before')) throw new Error('QMD patch input differs from reviewed artifacts; refusing installation.');
  const result = spawnSync(process.execPath, [require.resolve('patch-package'), '--error-on-fail', '--error-on-warn'], {
    cwd: root, stdio: 'inherit', shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (!matches('after')) throw new Error('QMD patch output differs from reviewed artifacts; refusing installation.');
}
