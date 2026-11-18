import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const STAGED_DIR = process.env.CLEC_STAGED_DIR ?? '/staged';
const RELEASES_DIR = process.env.CLEC_RELEASES_DIR ?? '/releases';
const FIXTURES_DIR = process.env.CLEC_FIXTURES_DIR ?? '/fixtures';
const WORK_DIR = process.env.CLEC_WORK_DIR ?? '/tmp/clec-work';
const OUT_DIR = process.env.CLEC_OUT_DIR ?? '/out';
const LIBC_LABEL = process.env.CLEC_LIBC_LABEL ?? 'unknown';
const TUPLE = process.env.CLEC_TUPLE ?? 'linux-arm64';
const TARGETS = new Map([
  ['linux-arm64', { machine: 183, wrongMachine: 62, interpreter: '/lib/ld-musl-aarch64.so.1' }],
  ['linux-x64', { machine: 62, wrongMachine: 183, interpreter: '/lib/ld-musl-x86_64.so.1' }],
]);
const target = TARGETS.get(TUPLE);
assert.ok(target, `Unsupported verification tuple: ${TUPLE}`);
assert.equal(`${process.platform}-${process.arch}`, TUPLE);
const EXPECTED_CLEC_SHA256 = process.env.CLEC_EXPECTED_SHA256;
const EXPECTED_SKILL_SHA256 = process.env.CLEC_SKILL_SHA256;
const EXPECTED_README_SHA256 = process.env.CLEC_README_SHA256;

assert.ok(EXPECTED_CLEC_SHA256, 'CLEC_EXPECTED_SHA256 is required');
assert.ok(EXPECTED_SKILL_SHA256, 'CLEC_SKILL_SHA256 is required');
assert.ok(EXPECTED_README_SHA256, 'CLEC_README_SHA256 is required');

const CMD_LOG_DIR = join(OUT_DIR, 'commands');
mkdirSync(WORK_DIR, { recursive: true });
mkdirSync(CMD_LOG_DIR, { recursive: true });

function sha256Buf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  return sha256Buf(readFileSync(filePath));
}

function runCmd(bin, args, options = {}) {
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    cwd: options.cwd ?? WORK_DIR,
    env: options.env ?? process.env,
    timeout: options.timeout ?? 60_000,
  });
  return {
    bin,
    args,
    status: res.status,
    signal: res.signal,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error ? res.error.message : null,
  };
}

function recordRun(name, bin, args, options = {}) {
  const res = runCmd(bin, args, options);
  writeFileSync(
    join(CMD_LOG_DIR, `${name}.json`),
    `${JSON.stringify({ name, bin, args, status: res.status, signal: res.signal, error: res.error }, null, 2)}\n`,
  );
  writeFileSync(join(CMD_LOG_DIR, `${name}.stdout`), res.stdout);
  writeFileSync(join(CMD_LOG_DIR, `${name}.stderr`), res.stderr);
  return res;
}

function parseJsonStdout(res, label) {
  assert.equal(res.status, 0, `${label} failed (status=${res.status}): ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function assertCommandParity(installed, direct) {
  for (const field of ['status', 'stdout', 'stderr']) {
    assert.equal(direct[field], installed[field], `Installed and direct ${installed.args.join(' ')} differ on ${field}`);
  }
}

function collectEnvironment() {
  const uname = runCmd('uname', ['-a']);
  const osRelease = existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : '';
  const ldd = runCmd('ldd', ['--version']);
  const nodeVer = runCmd('node', ['-v']);
  const npmVer = runCmd('npm', ['-v']);
  const reportHeader = process.report?.getReport?.()?.header ?? {};
  return {
    libcLabel: LIBC_LABEL,
    platform: process.platform,
    arch: process.arch,
    uname: uname.stdout.trim(),
    osRelease: osRelease.trim(),
    lddVersion: `${ldd.stdout}\n${ldd.stderr}`.trim(),
    nodeVersion: nodeVer.stdout.trim(),
    npmVersion: npmVer.stdout.trim(),
    glibcVersionRuntime: reportHeader.glibcVersionRuntime ?? null,
  };
}

function runNegativeInstallerControls(tgzPath, directClecPath) {
  const negRoot = join(WORK_DIR, 'negative-installer');
  rmSync(negRoot, { recursive: true, force: true });
  mkdirSync(negRoot, { recursive: true });

  const ignorePrefix = join(negRoot, 'ignore-scripts-prefix');
  const npmCache = join(negRoot, 'npm-cache');
  const igRes = recordRun(
    'neg-npm-ignore-scripts',
    'npm',
    ['install', '--global', '--offline', '--ignore-scripts', '--cache', npmCache, '--prefix', ignorePrefix, tgzPath],
  );
  assert.equal(igRes.status, 0, `--ignore-scripts install should unpack: ${igRes.stderr}`);
  const ignoredBin = join(ignorePrefix, 'bin', 'clec');
  const igExec = recordRun('neg-ignore-scripts-exec', ignoredBin, ['--version'], {
    env: { PATH: '/nonexistent-empty-path' },
  });
  assert.equal(readFileSync(ignoredBin)[0], 0, '--ignore-scripts must leave the package placeholder');
  assert.ok(igExec.status === 127 || igExec.error?.endsWith(' ENOEXEC'),
    'placeholder installed under --ignore-scripts must fail to execute');

  const unpackedDir = join(negRoot, 'unpacked');
  mkdirSync(unpackedDir, { recursive: true });
  const untar = runCmd('tar', ['-xzf', tgzPath, '-C', unpackedDir]);
  assert.equal(untar.status, 0, `tar extract failed: ${untar.stderr}`);
  const pkgDir = join(unpackedDir, 'package');

  const badShaDir = join(negRoot, 'pkg-bad-sha');
  cpSync(pkgDir, badShaDir, { recursive: true });
  const invBadSha = JSON.parse(readFileSync(join(badShaDir, 'inventory.json'), 'utf8'));
  invBadSha.targets[TUPLE].sha256 = '0'.repeat(64);
  writeFileSync(join(badShaDir, 'inventory.json'), JSON.stringify(invBadSha, null, 2));
  const badShaRes = recordRun('neg-install-bad-sha', 'node', [join(badShaDir, 'scripts', 'install.mjs')]);
  assert.notEqual(badShaRes.status, 0, 'corrupt inventory sha256 must fail install.mjs');
  assert.match(badShaRes.stderr, /SHA-256 mismatch/);
  assert.equal(readFileSync(join(badShaDir, 'bin', 'clec.exe'))[0], 0, 'placeholder must be restored');

  const wrongTupleDir = join(negRoot, 'pkg-wrong-tuple');
  cpSync(pkgDir, wrongTupleDir, { recursive: true });
  const wrongArchElf = Buffer.alloc(128, 0);
  wrongArchElf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  wrongArchElf.writeUInt16LE(3, 16);
  wrongArchElf.writeUInt16LE(target.wrongMachine, 18);
  wrongArchElf.writeUInt32LE(1, 20);
  wrongArchElf.writeUInt16LE(64, 52);
  const payloadPath = join(wrongTupleDir, 'payloads', TUPLE, 'clec');
  writeFileSync(payloadPath, wrongArchElf);
  const invWrong = JSON.parse(readFileSync(join(wrongTupleDir, 'inventory.json'), 'utf8'));
  invWrong.targets[TUPLE].bytes = wrongArchElf.length;
  invWrong.targets[TUPLE].sha256 = sha256Buf(wrongArchElf);
  writeFileSync(join(wrongTupleDir, 'inventory.json'), JSON.stringify(invWrong, null, 2));
  const wrongRes = recordRun('neg-install-wrong-arch', 'node', [join(wrongTupleDir, 'scripts', 'install.mjs')]);
  assert.notEqual(wrongRes.status, 0, `Wrong ELF machine in ${TUPLE} slot must fail install.mjs`);
  assert.match(wrongRes.stderr, /Executable format\/architecture mismatch/);
  assert.equal(readFileSync(join(wrongTupleDir, 'bin', 'clec.exe'))[0], 0);

  const interpDir = join(negRoot, 'pkg-pt-interp');
  cpSync(pkgDir, interpDir, { recursive: true });
  const interpStr = Buffer.from(`${target.interpreter}\0`, 'utf8');
  const interpElf = Buffer.alloc(64 + 56 + interpStr.length, 0);
  interpElf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  interpElf.writeUInt16LE(3, 16);
  interpElf.writeUInt16LE(target.machine, 18);
  interpElf.writeUInt32LE(1, 20);
  interpElf.writeBigUInt64LE(64n, 32);
  interpElf.writeUInt16LE(64, 52);
  interpElf.writeUInt16LE(56, 54);
  interpElf.writeUInt16LE(1, 56);
  interpElf.writeUInt32LE(3, 64);
  interpElf.writeBigUInt64LE(120n, 72);
  interpElf.writeBigUInt64LE(BigInt(interpStr.length), 96);
  interpStr.copy(interpElf, 120);
  writeFileSync(join(interpDir, 'payloads', TUPLE, 'clec'), interpElf);
  const invInterp = JSON.parse(readFileSync(join(interpDir, 'inventory.json'), 'utf8'));
  invInterp.targets[TUPLE].bytes = interpElf.length;
  invInterp.targets[TUPLE].sha256 = sha256Buf(interpElf);
  writeFileSync(join(interpDir, 'inventory.json'), JSON.stringify(invInterp, null, 2));
  const interpRes = recordRun('neg-install-pt-interp', 'node', [join(interpDir, 'scripts', 'install.mjs')]);
  assert.notEqual(interpRes.status, 0, 'ELF with PT_INTERP must fail musl-static install.mjs');
  assert.match(interpRes.stderr, /musl-static linkage/);
  assert.equal(readFileSync(join(interpDir, 'bin', 'clec.exe'))[0], 0);

  return {
    ignoreScriptsInstallExit: igRes.status,
    ignoreScriptsExecExit: igExec.status,
    badShaExit: badShaRes.status,
    wrongArchExit: wrongRes.status,
    ptInterpExit: interpRes.status,
    directClecSha256: sha256File(directClecPath),
  };
}

function spawnConcurrentSync(bin, args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('close', (code) => {
      resolvePromise({ status: code, stdout, stderr });
    });
  });
}

async function main() {
  const envInfo = collectEnvironment();
  if (LIBC_LABEL === 'glibc') {
    assert.ok(envInfo.glibcVersionRuntime, 'Node must report its glibc runtime');
  } else if (LIBC_LABEL === 'musl') {
    assert.equal(envInfo.glibcVersionRuntime, null);
    assert.match(envInfo.lddVersion, /musl libc/);
  }

  const tgzPath = join(STAGED_DIR, 'clec-cli-1.0.0-dev.0.tgz');
  const consumerName = `clec-v1.0.0-dev.0-${TUPLE}`;
  const consumerArchive = join(STAGED_DIR, `${consumerName}.tar.gz`);
  const directExtract = join(WORK_DIR, 'consumer-direct');
  rmSync(directExtract, { recursive: true, force: true });
  mkdirSync(directExtract, { recursive: true });
  const extractRes = runCmd('tar', ['-xzf', consumerArchive, '-C', directExtract]);
  assert.equal(extractRes.status, 0, `consumer archive extract failed: ${extractRes.stderr}`);
  const directClec = join(directExtract, consumerName, 'clec');
  assert.equal(sha256File(directClec), EXPECTED_CLEC_SHA256);

  const negativeControls = runNegativeInstallerControls(tgzPath, directClec);

  const unicodePrefix = join(WORK_DIR, 'prefix space 中文');
  const npmCache = join(WORK_DIR, 'npm-cache-install');
  rmSync(unicodePrefix, { recursive: true, force: true });
  const installRes = recordRun(
    'npm-install-global-offline',
    'npm',
    ['install', '--global', '--offline', '--cache', npmCache, '--prefix', unicodePrefix, tgzPath],
  );
  assert.equal(installRes.status, 0, `npm global offline install failed: ${installRes.stderr}`);

  const installedBin = join(unicodePrefix, 'bin', 'clec');
  const installedPkgRoot = join(unicodePrefix, 'lib', 'node_modules', '@clec', 'cli');
  const resolvedBin = realpathSync(installedBin);
  assert.equal(resolvedBin, realpathSync(join(installedPkgRoot, 'bin', 'clec.exe')));
  assert.notEqual(lstatSync(resolvedBin).mode & 0o111, 0, 'installed binary must be executable');
  assert.equal(sha256File(resolvedBin), EXPECTED_CLEC_SHA256, 'installed binary must match static ELF');
  assert.equal(sha256File(join(installedPkgRoot, 'skills', 'clec', 'SKILL.md')), EXPECTED_SKILL_SHA256);
  assert.equal(sha256File(join(installedPkgRoot, 'README.md')), EXPECTED_README_SHA256);

  const emptyPathEnv = { PATH: '/nonexistent-empty-path' };

  const preHashes = {
    releaseAManifest: sha256File(join(RELEASES_DIR, 'release-a', 'manifest.json')),
    releaseAZst: sha256File(join(RELEASES_DIR, 'release-a', 'corpus.sqlite.zst')),
    releaseBManifest: sha256File(join(RELEASES_DIR, 'release-b', 'manifest.json')),
    releaseBZst: sha256File(join(RELEASES_DIR, 'release-b', 'corpus.sqlite.zst')),
  };

  const verInstalled = recordRun('empty-path-version-installed', installedBin, ['--version'], { env: emptyPathEnv });
  const verDirect = recordRun('empty-path-version-direct', directClec, ['--version'], { env: emptyPathEnv });
  assert.equal(verInstalled.status, 0);
  assertCommandParity(verInstalled, verDirect);
  assert.match(verInstalled.stdout, /1\.0\.0-dev\.0/);

  const helpRes = recordRun('empty-path-help', installedBin, ['--help'], { env: emptyPathEnv });
  const helpDirect = recordRun('empty-path-help-direct', directClec, ['--help'], { env: emptyPathEnv });
  assert.equal(helpRes.status, 0);
  assertCommandParity(helpRes, helpDirect);

  const schemaRes = recordRun('empty-path-schema-no-home', installedBin, ['schema'], { env: emptyPathEnv });
  const schemaDirect = recordRun('empty-path-schema-direct', directClec, ['schema'], { env: emptyPathEnv });
  assertCommandParity(schemaRes, schemaDirect);
  const schemaJson = parseJsonStdout(schemaRes, 'schema');
  assert.equal(schemaJson.data.defaultConfigured, false);
  assert.equal(schemaJson.data.providerVerified, false);
  assert.equal(schemaJson.data.corpusFormat, 'clec-native-v2');

  const noHomeCwd = join(WORK_DIR, 'no-home-cwd');
  rmSync(noHomeCwd, { recursive: true, force: true });
  mkdirSync(noHomeCwd, { recursive: true });
  const noHomeStatus = recordRun('empty-path-status-no-home', installedBin, ['status'], {
    cwd: noHomeCwd,
    env: emptyPathEnv,
  });
  const statusDirect = recordRun('empty-path-status-no-home-direct', directClec, ['status'], {
    cwd: noHomeCwd,
    env: emptyPathEnv,
  });
  assert.equal(noHomeStatus.status, 4);
  assertCommandParity(noHomeStatus, statusDirect);
  const noHomeErr = JSON.parse(noHomeStatus.stderr);
  assert.equal(noHomeErr.error.code, 'INVALID_DATA_DIR');
  assert.equal(existsSync(join(noHomeCwd, '.local')), false, 'must not create ./.local fallback');

  const dataDir = join(WORK_DIR, 'data-dir space 中文');
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const unknownMarkerPath = join(dataDir, 'keep-unknown.txt');
  const unknownMarkerBytes = Buffer.from('preserve-unknown-marker\n', 'utf8');
  writeFileSync(unknownMarkerPath, unknownMarkerBytes);
  const unrelatedSqlitePath = join(dataDir, `${'b'.repeat(64)}.sqlite`);
  const unrelatedSqliteBytes = Buffer.from('not-managed-sqlite\n', 'utf8');
  writeFileSync(unrelatedSqlitePath, unrelatedSqliteBytes);

  const preStatus = parseJsonStdout(
    recordRun('empty-path-status-pre-sync', installedBin, ['--data-dir', dataDir, 'status'], { env: emptyPathEnv }),
    'pre-sync status',
  );
  assert.equal(preStatus.data.ready, false);
  assert.equal(preStatus.data.activeRelease, null);

  const noDataSearch = recordRun(
    'empty-path-search-no-data',
    installedBin,
    ['--offline', '--data-dir', dataDir, 'search', '0050'],
    { env: emptyPathEnv },
  );
  assert.equal(noDataSearch.status, 3);
  assert.equal(JSON.parse(noDataSearch.stderr).error.code, 'NO_DATA');

  const sag2Conflict = recordRun(
    'empty-path-sag2-offline-conflict',
    installedBin,
    ['--offline', '--sag2', '--data-dir', dataDir, 'search', '0050'],
    { env: emptyPathEnv },
  );
  assert.equal(sag2Conflict.status, 2);
  assert.equal(JSON.parse(sag2Conflict.stderr).error.code, 'OFFLINE_REQUIRED');

  const tinyBudget = recordRun(
    'empty-path-max-bytes-1',
    installedBin,
    ['--max-bytes', '1', 'schema'],
    { env: emptyPathEnv },
  );
  assert.equal(tinyBudget.status, 2);
  assert.equal(JSON.parse(tinyBudget.stderr).error.code, 'OUTPUT_BUDGET_TOO_SMALL');

  const syncA1 = parseJsonStdout(
    recordRun(
      'empty-path-sync-release-a-1',
      installedBin,
      ['--offline', '--data-dir', dataDir, 'sync', '--manifest', join(RELEASES_DIR, 'release-a', 'manifest.json')],
      { env: emptyPathEnv },
    ),
    'sync release-a 1',
  );
  assert.equal(syncA1.data.reused, false);
  const releaseAHash = syncA1.data.release;

  const syncA2 = parseJsonStdout(
    recordRun(
      'empty-path-sync-release-a-2',
      installedBin,
      ['--offline', '--data-dir', dataDir, 'sync', '--manifest', join(RELEASES_DIR, 'release-a', 'manifest.json')],
      { env: emptyPathEnv },
    ),
    'sync release-a 2',
  );
  assert.equal(syncA2.data.reused, true);
  assert.equal(syncA2.data.release, releaseAHash);

  const sourcesRes = parseJsonStdout(
    recordRun(
      'empty-path-sources-canonical',
      installedBin,
      ['--offline', '--data-dir', dataDir, 'sources', '--canonical-only'],
      { env: emptyPathEnv },
    ),
    'sources canonical',
  );
  assert.equal(sourcesRes.data.items.length, 3, 'dup_a.txt must collapse to sub_a.srt');
  const docSourceItem = sourcesRes.data.items.find((it) => it.path === 'doc_a.txt');
  assert.ok(docSourceItem, 'doc_a.txt must appear in canonical sources');

  const searchInstalled = recordRun(
    'empty-path-search-0050-qqq-installed',
    installedBin,
    ['--offline', '--data-dir', dataDir, 'search', '0050 QQQ 4%', '退休 提領 😀'],
    { env: emptyPathEnv },
  );
  const searchDirect = recordRun(
    'empty-path-search-0050-qqq-direct',
    directClec,
    ['--offline', '--data-dir', dataDir, 'search', '0050 QQQ 4%', '退休 提領 😀'],
    { env: emptyPathEnv },
  );
  assert.equal(searchInstalled.status, 0);
  assertCommandParity(searchInstalled, searchDirect);

  const searchJson = JSON.parse(searchInstalled.stdout);
  assert.equal(searchJson.data.mode, 'local');
  assert.ok(searchJson.data.hits.length >= 2, 'expected hits across authored UTF-8 fixture');
  const docHit = searchJson.data.hits.find((h) => h.source.path === 'doc_a.txt');
  assert.ok(docHit, 'doc_a.txt must appear in search hits');
  const actualPassageId = docHit.passageId;

  const readPassageInstalled = recordRun(
    'empty-path-read-passage-context-installed',
    installedBin,
    ['--offline', '--data-dir', dataDir, 'read', actualPassageId, '--context', '1'],
    { env: emptyPathEnv },
  );
  const readPassageDirect = recordRun(
    'empty-path-read-passage-context-direct',
    directClec,
    ['--offline', '--data-dir', dataDir, 'read', actualPassageId, '--context', '1'],
    { env: emptyPathEnv },
  );
  assert.equal(readPassageInstalled.status, 0);
  assertCommandParity(readPassageInstalled, readPassageDirect);

  const readPassageJson = JSON.parse(readPassageInstalled.stdout);
  const passageItem = readPassageJson.data.items[0];
  assert.equal(passageItem.kind, 'passage');
  const rawDocABytes = readFileSync(join(FIXTURES_DIR, 'release-a', 'workspace', 'doc_a.txt'));
  assert.deepEqual(rawDocABytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.ok(rawDocABytes.includes(Buffer.from('\r\n')), 'fixture must contain CRLF');
  const spanSlice = Buffer.concat(
    passageItem.spans.map((s) => rawDocABytes.subarray(s.startByte, s.endByte)),
  ).toString('utf8');
  assert.equal(spanSlice, passageItem.text, 'UTF-8 spans must slice raw fixture bytes identically');

  const readOrigRes = parseJsonStdout(
    recordRun(
      'empty-path-read-original-find',
      installedBin,
      ['--offline', '--data-dir', dataDir, 'read', docSourceItem.sourceId, '--original', '--find', '每年提領'],
      { env: emptyPathEnv },
    ),
    'read --original --find',
  );
  const origItem = readOrigRes.data.items[0];
  assert.equal(origItem.kind, 'sourceOriginal');
  assert.deepEqual(Buffer.from(origItem.originalText, 'utf8'), rawDocABytes, 'BOM+CRLF raw UTF-8 bytes must round-trip');
  assert.ok(origItem.literalMatches && origItem.literalMatches.length >= 1, '--find must match literal UTF-8 substring');

  const allPassageIds = searchJson.data.hits.map((h) => h.passageId);
  assert.ok(allPassageIds.length >= 2);
  const smallBudgetRun = recordRun(
    'empty-path-search-omission-budget',
    installedBin,
    ['--offline', '--max-bytes', '4000', '--data-dir', dataDir, 'search', '0050 QQQ 4%', '退休 提領 😀'],
    { env: emptyPathEnv },
  );
  const smallBudgetSearch = parseJsonStdout(smallBudgetRun, 'search small --max-bytes');
  assert.ok(Buffer.byteLength(smallBudgetRun.stdout) <= 4000, 'search stdout must fit the byte budget');
  assert.ok(smallBudgetSearch.data.budget.omittedCount > 0, 'small --max-bytes must report whole-item omission');
  assert.ok(smallBudgetSearch.data.budget.omittedIds.length > 0, 'small --max-bytes must populate omittedIds');

  const activeSqlite = join(dataDir, `${releaseAHash}.sqlite`);
  const activeSqliteSha = sha256File(activeSqlite);
  const corruptSync = recordRun(
    'empty-path-sync-corrupt-b-rollback',
    installedBin,
    ['--offline', '--data-dir', dataDir, 'sync', '--manifest', join(RELEASES_DIR, 'release-b-corrupt', 'manifest.json')],
    { env: emptyPathEnv },
  );
  assert.equal(corruptSync.status, 5);
  assert.equal(JSON.parse(corruptSync.stderr).error.code, 'INTEGRITY_MISMATCH');

  const statusAfterRollback = parseJsonStdout(
    recordRun('empty-path-status-after-rollback', installedBin, ['--data-dir', dataDir, 'status'], { env: emptyPathEnv }),
    'status after rollback',
  );
  assert.equal(statusAfterRollback.data.activeRelease, releaseAHash);
  assert.equal(sha256File(activeSqlite), activeSqliteSha, 'rollback must preserve the active snapshot bytes');
  assert.deepEqual(readFileSync(unknownMarkerPath), unknownMarkerBytes);
  assert.deepEqual(readFileSync(unrelatedSqlitePath), unrelatedSqliteBytes);

  const syncB = parseJsonStdout(
    recordRun(
      'empty-path-sync-release-b',
      installedBin,
      ['--offline', '--data-dir', dataDir, 'sync', '--manifest', join(RELEASES_DIR, 'release-b', 'manifest.json')],
      { env: emptyPathEnv },
    ),
    'sync release-b',
  );
  assert.notEqual(syncB.data.release, releaseAHash);
  const statusAfterActivation = parseJsonStdout(
    recordRun('empty-path-status-after-activation', installedBin, ['--data-dir', dataDir, 'status'], { env: emptyPathEnv }),
    'status after activation',
  );
  assert.equal(statusAfterActivation.data.activeRelease, syncB.data.release);
  assert.equal(existsSync(activeSqlite), false, 'prior native active sqlite cleaned up');
  assert.deepEqual(readFileSync(unknownMarkerPath), unknownMarkerBytes, 'unknown marker file preserved');
  assert.deepEqual(readFileSync(unrelatedSqlitePath), unrelatedSqliteBytes, 'unrelated 71-char sqlite preserved');

  const lockDataDir = join(WORK_DIR, 'data-dir-lock');
  rmSync(lockDataDir, { recursive: true, force: true });
  mkdirSync(lockDataDir, { recursive: true });
  const [race1, race2] = await Promise.all([
    spawnConcurrentSync(
      installedBin,
      ['--offline', '--data-dir', lockDataDir, 'sync', '--manifest', join(RELEASES_DIR, 'release-a', 'manifest.json')],
      emptyPathEnv,
    ),
    spawnConcurrentSync(
      installedBin,
      ['--offline', '--data-dir', lockDataDir, 'sync', '--manifest', join(RELEASES_DIR, 'release-a', 'manifest.json')],
      emptyPathEnv,
    ),
  ]);
  writeFileSync(join(CMD_LOG_DIR, 'concurrent-sync-race.json'), `${JSON.stringify({ race1, race2 }, null, 2)}\n`);
  const raceExits = [race1.status, race2.status];
  assert.ok(raceExits.includes(0), 'at least one concurrent sync must succeed');
  for (const r of [race1, race2]) {
    if (r.status !== 0) {
      assert.equal(r.status, 4);
      assert.equal(JSON.parse(r.stderr).error.code, 'SYNC_LOCKED');
    }
  }
  const statusAfterRace = parseJsonStdout(
    recordRun('empty-path-status-after-race', installedBin, ['--data-dir', lockDataDir, 'status'], { env: emptyPathEnv }),
    'status after concurrent race',
  );
  assert.equal(statusAfterRace.data.ready, true);
  assert.equal(statusAfterRace.data.activeRelease, releaseAHash);

  const postHashes = {
    releaseAManifest: sha256File(join(RELEASES_DIR, 'release-a', 'manifest.json')),
    releaseAZst: sha256File(join(RELEASES_DIR, 'release-a', 'corpus.sqlite.zst')),
    releaseBManifest: sha256File(join(RELEASES_DIR, 'release-b', 'manifest.json')),
    releaseBZst: sha256File(join(RELEASES_DIR, 'release-b', 'corpus.sqlite.zst')),
  };
  assert.deepEqual(postHashes, preHashes, 'corpus releases must remain immutable');

  const receipt = {
    libcLabel: LIBC_LABEL,
    environment: envInfo,
    negativeControls,
    installedPath: installedBin,
    installedResolvedBinary: resolvedBin,
    installedBinarySha256: sha256File(resolvedBin),
    installedSkillSha256: sha256File(join(installedPkgRoot, 'skills', 'clec', 'SKILL.md')),
    installedReadmeSha256: sha256File(join(installedPkgRoot, 'README.md')),
    releaseAHash,
    releaseBHash: syncB.data.release,
    sampledPassageId: actualPassageId,
    sampledDocSourceId: docSourceItem.sourceId,
    concurrentRaceExits: raceExits,
    preHashes,
    postHashes,
    allChecksPassed: true,
  };
  writeFileSync(join(OUT_DIR, 'guest-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`guest_verify failed: ${err.stack || err.message}\n`);
  process.exit(1);
});
