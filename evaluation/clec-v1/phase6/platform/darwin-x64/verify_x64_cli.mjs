import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
assert.equal(root, process.cwd(), 'Run from the exclusive directory allocated by the Python driver');
const work = join(root, 'cli-work');
const logs = join(root, 'logs', 'cli', 'commands');
mkdirSync(work);
mkdirSync(logs);
const emptyPath = join(work, 'absent-path');
const nativeEnv = { PATH: emptyPath };
const tools = join(root, 'x64-tools');
const npmRoot = '/usr/local/lib/node_modules/npm/bin';
const node = process.execPath;

function write(path, bytes) {
  writeFileSync(path, bytes, { flag: 'wx' });
}

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function record(label, bin, args, cwd, env, result) {
  const { stdout, stderr, status, signal, error } = result;
  write(join(logs, label + '.json'), JSON.stringify({
    argv: [bin, ...args], cwd, env, status, signal, error: error?.code ?? null,
  }, null, 2) + '\n');
  write(join(logs, label + '.stdout'), stdout ?? '');
  write(join(logs, label + '.stderr'), stderr ?? '');
}

function run(label, bin, args, { cwd = work, env = nativeEnv, input } = {}) {
  const result = spawnSync(bin, args, { cwd, env, input, encoding: 'utf8', timeout: 60_000 });
  record(label, bin, args, cwd, env, result);
  return result;
}

function success(result) {
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}

function data(result) {
  return JSON.parse(success(result)).data;
}

function expectError(result, status, code) {
  assert.equal(result.status, status, result.stderr);
  assert.equal(JSON.parse(result.stderr).error.code, code);
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileSha(path) {
  return sha(readFileSync(path));
}

function npmEnvironment(parent) {
  for (const folder of ['home', 'cache', 'tmp']) mkdirSync(join(parent, folder), { recursive: true });
  for (const file of ['user.npmrc', 'global.npmrc']) write(join(parent, file), '');
  return {
    HOME: join(parent, 'home'),
    TMPDIR: join(parent, 'tmp'),
    PATH: `${tools}:/usr/bin:/bin`,
    npm_config_userconfig: join(parent, 'user.npmrc'),
    npm_config_globalconfig: join(parent, 'global.npmrc'),
    npm_config_cache: join(parent, 'cache'),
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
}

function verifyInstallation() {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'x64');
  assert.equal(node, join(tools, 'node'));
  const translated = success(run('guest-translated', '/usr/sbin/sysctl', ['-n', 'sysctl.proc_translated'])).trim();
  assert.equal(translated, '1');
  assert.equal(success(run('guest-uname', '/usr/bin/uname', ['-m'])).trim(), 'x86_64');

  const stage = join(root, 'staged-1');
  const tgz = join(stage, 'clec-cli-1.0.0-dev.0.tgz');
  const releaseName = 'clec-v1.0.0-dev.0-darwin-x64';
  const directDir = join(work, 'consumer');
  mkdirSync(directDir);
  success(run('extract-consumer', '/usr/bin/tar', ['-xzf', join(stage, releaseName + '.tar.gz'), '-C', directDir]));
  const direct = join(directDir, releaseName, 'clec');
  const expectedSha = fileSha(join(root, 'bin', 'release', 'clec'));
  assert.equal(fileSha(direct), expectedSha);

  const prefix = join(work, 'prefix space 中文');
  const packageAt = (p) => join(p, 'lib', 'node_modules', '@clec', 'cli');
  const installed = join(prefix, 'bin', 'clec');
  const pkgRoot = packageAt(prefix);
  const env = npmEnvironment(join(work, 'npm'));
  const npm = (label, args) => run(label, node, [join(npmRoot, 'npm-cli.js'), ...args], { env });
  const install = (label, where, ...options) => npm(label, [
    'install', '--global', '--offline', '--foreground-scripts', '--prefix', where, ...options, tgz,
  ]);
  const npmVersion = success(npm('npm-version', ['--version'])).trim();
  const installOutput = success(install('npm-install-global-offline', prefix));
  assert.match(installOutput, /Installed @clec\/cli@1\.0\.0-dev\.0 \(darwin-x64, /);
  assert.ok(installOutput.includes(expectedSha));
  assert.ok(lstatSync(installed).isSymbolicLink());
  const resolved = realpathSync(installed);
  assert.equal(resolved, realpathSync(join(pkgRoot, 'bin', 'clec.exe')));
  assert.ok(lstatSync(resolved).mode & 0o111);
  assert.equal(fileSha(resolved), expectedSha);
  for (const file of ['skills/clec/SKILL.md', 'README.md', 'NOTICES.md']) {
    assert.equal(fileSha(join(pkgRoot, file)), fileSha(join(root, 'src-export', 'cli', file)));
  }

  const npxVersion = success(run('npx-offline-node-dependent', node, [
    join(npmRoot, 'npx-cli.js'), '--offline', '--yes', '--package', tgz, '--', 'clec', '--version',
  ], { env })).trim();
  assert.match(npxVersion, /1\.0\.0-dev\.0/);

  const ignoredPrefix = join(work, 'ignored prefix');
  const ignoredBin = join(ignoredPrefix, 'bin', 'clec');
  const ignoredPackage = packageAt(ignoredPrefix);
  success(install('npm-ignore-scripts', ignoredPrefix, '--ignore-scripts'));
  const placeholder = readFileSync(join(root, 'src-export', 'cli', 'bin', 'clec.exe'));
  assert.deepEqual(readFileSync(ignoredBin), placeholder);
  const ignored = run('ignore-scripts-execution', '/bin/sh', [
    '-c', 'exec "$@"', 'sh', ignoredBin, '--version',
  ]);
  assert.ok(Number.isInteger(ignored.status) && ignored.status !== 0);
  assert.match(ignored.stderr, /cannot execute binary file/);
  const installer = (label, p) => run(label, node, [join(p, 'scripts', 'install.mjs')], { env });
  success(installer('ignore-scripts-repair', ignoredPackage));
  assert.equal(fileSha(ignoredBin), expectedSha);
  assert.equal(success(run('repaired-execution', ignoredBin, ['--version'])).trim(), npxVersion);

  const armFixture = join(work, 'arm64e-true');
  success(run('wrong-arch-fixture', '/usr/bin/lipo', ['-thin', 'arm64e', '/usr/bin/true', '-output', armFixture]));
  const controls = [
    ['checksum', null, /SHA-256 mismatch/],
    ['wrong-arch', armFixture, /Executable format\/architecture mismatch/],
    ['test-hooks', join(root, 'bin', 'test-hooks', 'clec_test_fixture'), /test-hooks feature/],
  ];
  for (const [label, replacement, expected] of controls) {
    const badPackage = join(work, label);
    cpSync(pkgRoot, badPackage, { recursive: true, errorOnExist: true, force: false });
    const payload = join(badPackage, 'payloads', 'darwin-x64', 'clec');
    const inventoryPath = join(badPackage, 'inventory.json');
    const inventory = json(inventoryPath);
    const entry = inventory.targets['darwin-x64'];
    if (replacement) {
      const bytes = readFileSync(replacement);
      writeFileSync(payload, bytes);
      entry.sha256 = sha(bytes);
      entry.bytes = bytes.length;
    } else {
      entry.sha256 = '0'.repeat(64);
    }
    writeFileSync(inventoryPath, JSON.stringify(inventory));
    const result = installer(label, badPackage);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, expected);
    assert.deepEqual(readFileSync(join(badPackage, 'bin', 'clec.exe')), placeholder);
  }

  success(install('npm-repeat-install', prefix));
  assert.equal(fileSha(installed), expectedSha);
  success(npm('npm-uninstall', ['uninstall', '--global', '--offline', '--prefix', ignoredPrefix, '@clec/cli']));
  assert.equal(lstatSync(ignoredBin, { throwIfNoEntry: false }), undefined);
  assert.ok(!existsSync(ignoredPackage));
  return { direct, installed, resolved, expectedSha, npmVersion, npxVersion, translated, ignoreScriptsExit: ignored.status };
}

function compare(label, programs, args, options = {}) {
  const direct = run(label + '-direct', programs.direct, args, options);
  const installed = run(label + '-installed', programs.installed, args, options);
  assert.equal(direct.status, installed.status, label);
  assert.equal(direct.signal, installed.signal, label);
  assert.equal(direct.stdout, installed.stdout, label);
  assert.equal(direct.stderr, installed.stderr, label);
  return installed;
}

function verifyCorpus(programs) {
  const both = (label, args, options) => compare(label, programs, args, options);
  const noHome = join(work, 'no-home');
  mkdirSync(noHome);
  assert.match(success(both('version', ['--version'])), /1\.0\.0-dev\.0/);
  success(both('help', ['--help']));
  const schema = data(both('schema-no-home', ['schema'], { cwd: noHome }));
  assert.equal(schema.defaultConfigured, false);
  assert.equal(schema.providerVerified, false);
  assert.equal(schema.corpusFormat, 'clec-native-v2');
  expectError(both('status-no-home', ['status'], { cwd: noHome }), 4, 'INVALID_DATA_DIR');
  assert.deepEqual(readdirSync(noHome), []);

  const dir = join(work, 'data space 中文');
  mkdirSync(dir);
  const args = ['--offline', '--data-dir', dir];
  const use = (label, extra, options) => both(label, [...args, ...extra], options);
  const release = (name) => join(root, 'releases', name, 'manifest.json');
  const sync = (name, directory = dir) => [
    '--offline', '--data-dir', directory, 'sync', '--manifest', release(name),
  ];
  const seed = { 'unknown.txt': 'unknown\n', [`${'b'.repeat(64)}.sqlite`]: 'unowned sqlite\n' };
  const seedFiles = (directory, files) => {
    for (const [name, bytes] of Object.entries(files)) write(join(directory, name), bytes);
  };
  const preserved = (directory, files) => {
    for (const [name, bytes] of Object.entries(files)) assert.deepEqual(readFileSync(join(directory, name), 'utf8'), bytes);
  };
  seedFiles(dir, seed);
  assert.equal(data(use('status-empty', ['status'])).ready, false);
  expectError(use('search-no-data', ['search', '0050']), 3, 'NO_DATA');
  expectError(use('offline-sag2-conflict', ['--sag2', 'search', '0050']), 2, 'OFFLINE_REQUIRED');
  expectError(both('budget-too-small', ['--max-bytes', '1', 'schema']), 2, 'OUTPUT_BUDGET_TOO_SMALL');

  const legacy = join(work, 'legacy');
  const legacyFiles = { ...seed, current: 'legacy pointer\n' };
  mkdirSync(legacy);
  seedFiles(legacy, legacyFiles);
  expectError(both('legacy-sync', sync('release-a', legacy)), 4, 'INVALID_DATA_DIR');
  preserved(legacy, legacyFiles);
  assert.deepEqual(readdirSync(legacy).sort(), Object.keys(legacyFiles).sort());

  const first = data(run('sync-a-initial', programs.direct, sync('release-a')));
  assert.equal(first.reused, false);
  const reused = data(both('sync-a-reuse', sync('release-a')));
  assert.equal(reused.release, first.release);
  assert.equal(reused.reused, true);
  const sources = data(use('sources-canonical', ['sources', '--canonical-only'])).items;
  assert.equal(sources.length, 3);
  const doc = sources.find((item) => item.path === 'doc_a.txt');
  assert.equal(doc?.role, 'document');
  assert.equal(sources.find((item) => item.path === 'notes_b.md')?.role, 'summary');
  const query = ['search', '0050 QQQ 4%', '退休 提領 😀'];
  const full = data(use('search-unicode-pipe', query, { input: 'unused piped input\n' }));
  assert.equal(full.mode, 'local');
  assert.ok(full.hits.length >= 2);
  const hit = full.hits.find((item) => item.source.path === doc.path);
  assert.ok(hit);
  const raw = readFileSync(join(root, 'fixtures', 'release-a', 'workspace', doc.path));
  function exactSpans(item) {
    assert.ok(item.spans.length > 0);
    const sliced = item.spans.map(({ startByte, endByte }) => {
      assert.ok(Number.isInteger(startByte) && Number.isInteger(endByte));
      assert.ok(0 <= startByte && startByte < endByte && endByte <= raw.length);
      return raw.subarray(startByte, endByte);
    });
    assert.deepEqual(Buffer.concat(sliced), Buffer.from(item.text));
  }
  exactSpans(hit);
  for (const context of ['1', '2']) {
    const [item] = data(use('read-context-' + context, ['read', hit.passageId, '--context', context])).items;
    assert.equal(item.passageId, hit.passageId);
    exactSpans(item);
    for (const adjacent of item.context) exactSpans(adjacent);
  }
  const needle = '每年提領';
  const [original] = data(use('read-original-find', ['read', doc.sourceId, '--original', '--find', needle])).items;
  assert.equal(original.kind, 'sourceOriginal');
  assert.deepEqual(Buffer.from(original.originalText), raw);
  assert.ok(original.literalMatches.length > 0);
  for (const match of original.literalMatches) {
    assert.deepEqual(raw.subarray(match.startByte, match.endByte), Buffer.from(needle));
  }

  const bounded = use('search-omission-budget', ['--max-bytes', '4000', ...query]);
  const budget = data(bounded);
  const stdoutBytes = Buffer.byteLength(bounded.stdout);
  assert.ok(stdoutBytes <= 4000);
  assert.ok(budget.budget.omittedCount > 0);
  assert.equal(budget.hits.length + budget.budget.omittedCount, full.hits.length);
  assert.deepEqual(budget.hits, full.hits.slice(0, budget.hits.length));
  assert.deepEqual(budget.budget.omittedIds, full.hits.slice(budget.hits.length).map((item) => item.passageId));

  const oldDatabase = join(dir, first.release + '.sqlite');
  const active = join(dir, 'active.json');
  const before = [fileSha(oldDatabase), fileSha(active)];
  expectError(both('sync-b-corrupt', sync('release-b-corrupt')), 5, 'INTEGRITY_MISMATCH');
  assert.deepEqual([fileSha(oldDatabase), fileSha(active)], before);
  assert.equal(data(use('status-after-rollback', ['status'])).activeRelease, first.release);
  preserved(dir, seed);

  const second = data(run('sync-b-initial', programs.installed, sync('release-b')));
  assert.notEqual(second.release, first.release);
  assert.equal(data(use('status-after-upgrade', ['status'])).activeRelease, second.release);
  assert.ok(existsSync(join(dir, second.release + '.sqlite')));
  assert.ok(!existsSync(oldDatabase));
  preserved(dir, seed);
  return { releaseA: first.release, releaseB: second.release, passageId: hit.passageId, stdoutBytes,
    omittedCount: budget.budget.omittedCount, originalSha256: sha(raw) };
}

async function signalParity({ direct, installed }) {
  const sockets = new Set();
  let onRequest;
  const server = createServer(() => onRequest?.());
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/manifest.json`;
  try {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      const results = [];
      for (const [kind, binary] of Object.entries({ direct, installed })) {
        const directory = join(work, signal + '-' + kind);
        const args = ['--data-dir', directory, 'sync', '--manifest', url];
        const result = await new Promise((resolve, reject) => {
          const child = spawn(binary, args, { cwd: work, env: nativeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          let stderr = '';
          let delivered = false;
          child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
          child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
          onRequest = () => { delivered = child.kill(signal); };
          const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
          child.once('error', reject);
          child.once('close', (status, observed) => {
            clearTimeout(timeout);
            onRequest = undefined;
            resolve({ status, signal: observed, stdout, stderr, delivered });
          });
        });
        const label = signal + '-' + kind;
        record(label, binary, args, work, nativeEnv, result);
        assert.equal(result.delivered, true, label);
        assert.equal(result.signal, signal, label);
        assert.equal(result.status, null, label);
        assert.ok(!existsSync(join(directory, 'active.json')), label);
        results.push(result);
      }
      assert.deepEqual(results[0], results[1], signal);
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

const installation = verifyInstallation();
const corpus = verifyCorpus(installation);
await signalParity(installation);
write(join(root, 'receipts', 'darwin-x64-cli.json'), JSON.stringify({
  installation, corpus, nodeVersion: process.version, arch: process.arch,
  signalParity: ['SIGTERM', 'SIGINT'],
}, null, 2) + '\n');
