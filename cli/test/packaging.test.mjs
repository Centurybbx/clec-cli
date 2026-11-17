import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createDeterministicTarGz, createDeterministicZip } from '../scripts/archive.mjs';
import { installFromRoot } from '../scripts/install.mjs';
import { stageRelease } from '../scripts/stage.mjs';
import { PACKAGE_NAME, PACKAGE_VERSION, TARGET_MATRIX } from '../scripts/targets.mjs';

const CLI_ROOT = resolve(import.meta.dirname, '..');

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function makeFakeStagingPackage(root, tuple, payloadBytes) {
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'payloads', tuple), { recursive: true });
  const binName = tuple.startsWith('win32') ? 'clec.exe' : 'clec';
  const payloadRel = `payloads/${tuple}/${binName}`;
  writeFileSync(join(root, payloadRel), payloadBytes);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: PACKAGE_NAME, version: PACKAGE_VERSION }),
  );
  writeFileSync(join(root, 'bin', 'clec.exe'), Buffer.from('\x00\x00\x00\x00PLACEHOLDER\n'));
  writeFileSync(
    join(root, 'inventory.json'),
    JSON.stringify({
      schemaVersion: 1,
      packageName: PACKAGE_NAME,
      packageVersion: PACKAGE_VERSION,
      complete: false,
      publishable: false,
      targets: {
        [tuple]: {
          status: 'present',
          platform: tuple.split('-')[0],
          arch: tuple.split('-')[1],
          rustTarget: 'synthetic',
          binaryName: binName,
          payloadPath: payloadRel,
          bytes: payloadBytes.length,
          sha256: sha256(payloadBytes),
        },
      },
    }),
  );
}

test('target matrix contains exactly the five declared tuples', () => {
  assert.deepEqual(
    TARGET_MATRIX.map((t) => [t.tuple, t.rustTarget]),
    [
      ['darwin-arm64', 'aarch64-apple-darwin'],
      ['darwin-x64', 'x86_64-apple-darwin'],
      ['linux-x64', 'x86_64-unknown-linux-musl'],
      ['linux-arm64', 'aarch64-unknown-linux-musl'],
      ['win32-x64', 'x86_64-pc-windows-msvc'],
    ],
  );
});

test('deterministic archive writers produce byte-identical output independent of input order', () => {
  const entriesA = [
    { path: 'dir/b.txt', data: Buffer.from('beta'), executable: false },
    { path: 'dir/a.bin', data: Buffer.from('alpha'), executable: true },
  ];
  const entriesB = [entriesA[1], entriesA[0]];

  const tgz1 = createDeterministicTarGz(entriesA);
  const tgz2 = createDeterministicTarGz(entriesB);
  assert.equal(sha256(tgz1), sha256(tgz2));

  const zip1 = createDeterministicZip(entriesA);
  const zip2 = createDeterministicZip(entriesB);
  assert.equal(sha256(zip1), sha256(zip2));
  assert.equal(zip1.subarray(0, 4).toString('hex'), '504b0304');
});

test('installer validates length, sha256, path safety, unsupported tuples, and restores placeholder on failure', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'clec-install-unit-'));
  try {
    const pkgValid = join(tmp, 'valid');
    const payload = Buffer.from('#!/bin/sh\necho native-ok\n');
    makeFakeStagingPackage(pkgValid, 'darwin-arm64', payload);

    const receipt = installFromRoot(pkgValid, { platform: 'darwin', arch: 'arm64' });
    assert.equal(receipt.tuple, 'darwin-arm64');
    assert.equal(receipt.bytes, payload.length);
    assert.equal(receipt.sha256, sha256(payload));
    const installed = readFileSync(join(pkgValid, 'bin', 'clec.exe'));
    assert.deepEqual(installed, payload);
    assert.notEqual(lstatSync(join(pkgValid, 'bin', 'clec.exe')).mode & 0o111, 0);

    assert.throws(
      () => installFromRoot(pkgValid, { platform: 'freebsd', arch: 'x64' }),
      /Unsupported platform\/architecture/,
    );
    assert.equal(readFileSync(join(pkgValid, 'bin', 'clec.exe'))[0], 0);

    assert.throws(
      () => installFromRoot(pkgValid, { platform: 'linux', arch: 'x64' }),
      /not included in this package/,
    );

    writeFileSync(join(pkgValid, 'payloads', 'darwin-arm64', 'clec'), Buffer.from('X'.repeat(payload.length)));
    assert.throws(
      () => installFromRoot(pkgValid, { platform: 'darwin', arch: 'arm64' }),
      /SHA-256 mismatch/,
    );
    assert.equal(readFileSync(join(pkgValid, 'bin', 'clec.exe'))[0], 0);

    writeFileSync(join(pkgValid, 'payloads', 'darwin-arm64', 'clec'), Buffer.from('short'));
    assert.throws(
      () => installFromRoot(pkgValid, { platform: 'darwin', arch: 'arm64' }),
      /byte length mismatch/,
    );

    const symPkg = join(tmp, 'sym');
    cpSync(pkgValid, symPkg, { recursive: true });
    rmSync(join(symPkg, 'payloads', 'darwin-arm64', 'clec'));
    writeFileSync(join(tmp, 'outside'), payload);
    symlinkSync(join(tmp, 'outside'), join(symPkg, 'payloads', 'darwin-arm64', 'clec'));
    assert.throws(
      () => installFromRoot(symPkg, { platform: 'darwin', arch: 'arm64' }),
      /regular file, not a symlink/,
    );

    const travPkg = join(tmp, 'trav');
    makeFakeStagingPackage(travPkg, 'darwin-arm64', payload);
    const inv = JSON.parse(readFileSync(join(travPkg, 'inventory.json'), 'utf8'));
    inv.targets['darwin-arm64'].payloadPath = 'payloads/../../etc/passwd';
    writeFileSync(join(travPkg, 'inventory.json'), JSON.stringify(inv));
    assert.throws(
      () => installFromRoot(travPkg, { platform: 'darwin', arch: 'arm64' }),
      /Unsafe payloadPath/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('stageRelease rejects incomplete production staging, enforces allowlist, and repacks deterministically', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'clec-stage-unit-'));
  try {
    const fakeBins = join(tmp, 'bins');
    mkdirSync(fakeBins, { recursive: true });
    const clecBin = join(fakeBins, 'clec');
    const pubBin = join(fakeBins, 'clec-publish');
    const valBin = join(fakeBins, 'clec-validate');
    writeFileSync(clecBin, Buffer.from('ELF_OR_MACHO_CLEC'));
    writeFileSync(pubBin, Buffer.from('ELF_OR_MACHO_PUB'));
    writeFileSync(valBin, Buffer.from('ELF_OR_MACHO_VAL'));
    chmodSync(clecBin, 0o755);
    chmodSync(pubBin, 0o755);
    chmodSync(valBin, 0o755);

    const partialInput = join(tmp, 'partial.json');
    writeFileSync(
      partialInput,
      JSON.stringify({
        targets: {
          'darwin-arm64': {
            clec: clecBin,
            clecPublish: pubBin,
            clecValidate: valBin,
            executionEvidence: 'unit-synthetic',
          },
        },
      }),
    );

    assert.throws(
      () =>
        stageRelease(
          {
            input: partialInput,
            output: join(tmp, 'prod-out'),
            allowPartial: false,
            sourceCommit: '0'.repeat(40),
            rustcVersion: '1.89.0',
            buildCommand: 'synthetic',
            hostBaseline: 'test',
          },
          CLI_ROOT,
        ),
      /Refusing incomplete production staging/,
    );

    const out1 = join(tmp, 'stage1');
    const out2 = join(tmp, 'stage2');
    const opts1 = {
      input: partialInput,
      output: out1,
      allowPartial: true,
      sourceCommit: '0'.repeat(40),
      rustcVersion: '1.89.0',
      buildCommand: 'synthetic',
      hostBaseline: 'test',
    };
    const opts2 = { ...opts1, output: out2 };
    const res1 = stageRelease(opts1, CLI_ROOT);
    const res2 = stageRelease(opts2, CLI_ROOT);

    assert.equal(res1.complete, false);
    assert.equal(res1.publishable, false);
    assert.equal(res1.sha256sumsSha256, res2.sha256sumsSha256);

    const inv = JSON.parse(readFileSync(join(out1, 'inventory.json'), 'utf8'));
    assert.equal(inv.complete, false);
    assert.equal(inv.publishable, false);
    assert.equal(inv.targets['darwin-arm64'].status, 'present');
    assert.equal(inv.targets['linux-x64'].status, 'missing');

    for (const art of res1.artifacts) {
      assert.equal(
        sha256(readFileSync(join(out1, art.filename))),
        sha256(readFileSync(join(out2, art.filename))),
        `repack hash mismatch for ${art.filename}`,
      );
    }

    const hookInput = join(tmp, 'hook.json');
    const hookBin = join(fakeBins, 'clec_test_fixture');
    writeFileSync(hookBin, Buffer.from('HOOK'));
    writeFileSync(hookInput, JSON.stringify({ targets: { 'darwin-arm64': { clec: hookBin } } }));
    assert.throws(
      () =>
        stageRelease(
          { ...opts1, output: join(tmp, 'hook-out'), input: hookInput },
          CLI_ROOT,
        ),
      /test-hooks fixture/,
    );
    assert.equal(existsSync(join(tmp, 'hook-out', 'clec-cli-1.0.0-dev.0.tgz')), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
