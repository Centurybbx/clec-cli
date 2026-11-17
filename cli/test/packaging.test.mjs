import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createDeterministicTarGz, createDeterministicZip } from '../scripts/archive.mjs';
import {
  IDENTITY_PREFIX,
  IDENTITY_SUFFIX,
  assertExecutableMatchesTarget,
  extractEmbeddedBuildIdentity,
  inspectExecutableContainer,
} from '../scripts/artifact-admission.mjs';
import { captureBuildReceipt } from '../scripts/build-receipt.mjs';
import { installFromRoot } from '../scripts/install.mjs';
import { stageRelease } from '../scripts/stage.mjs';
import {
  NATIVE_CRATE_NAME,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  TARGET_MATRIX,
  findTargetByPlatformArch,
  findTargetByTuple,
} from '../scripts/targets.mjs';

const CLI_ROOT = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(CLI_ROOT, '..');
const DEFAULT_LOCK_SHA = '200070e2a526320a876dfecd70611583d654172ef87d59ce9d572e3aaf860cda';
const DEFAULT_COMMIT = 'a'.repeat(40);
const DEFAULT_RUSTC = 'rustc 1.89.0 (29483883e 2025-08-04)';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function makeContainerHeader(tuple, options = {}) {
  if (tuple === 'darwin-arm64' || tuple === 'darwin-x64') {
    const hdr = Buffer.alloc(64, 0);
    hdr.writeUInt32LE(0xfeedfacf, 0);
    hdr.writeInt32LE(tuple === 'darwin-arm64' ? 0x0100000c : 0x01000007, 4);
    hdr.writeUInt32LE(options.fileType ?? 2, 12);
    hdr.writeUInt32LE(0, 16);
    hdr.writeUInt32LE(0, 20);
    return hdr;
  }
  if (tuple === 'linux-x64' || tuple === 'linux-arm64') {
    const interpBuf = options.interp !== undefined ? Buffer.from(`${options.interp}\0`, 'utf8') : null;
    const hdrSize = 64 + (interpBuf ? 56 + interpBuf.length : 0);
    const hdr = Buffer.alloc(hdrSize, 0);
    hdr.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
    hdr.writeUInt16LE(options.eType ?? 3, 16);
    hdr.writeUInt16LE(tuple === 'linux-x64' ? 62 : 183, 18);
    hdr.writeUInt32LE(1, 20);
    hdr.writeUInt16LE(64, 52);
    if (interpBuf) {
      hdr.writeBigUInt64LE(64n, 32);
      hdr.writeUInt16LE(56, 54);
      hdr.writeUInt16LE(1, 56);
      const phOff = 64;
      hdr.writeUInt32LE(3, phOff);
      hdr.writeBigUInt64LE(120n, phOff + 8);
      hdr.writeBigUInt64LE(BigInt(interpBuf.length), phOff + 32);
      interpBuf.copy(hdr, 120);
    }
    return hdr;
  }
  if (tuple === 'win32-x64') {
    const hdr = Buffer.alloc(160, 0);
    hdr[0] = 0x4d;
    hdr[1] = 0x5a;
    const peOff = 0x40;
    hdr.writeUInt32LE(peOff, 0x3c);
    hdr.write('PE\0\0', peOff, 'ascii');
    hdr.writeUInt16LE(0x8664, peOff + 4);
    hdr.writeUInt16LE(24, peOff + 20);
    hdr.writeUInt16LE(options.characteristics ?? 0x0002, peOff + 22);
    hdr.writeUInt16LE(0x020b, peOff + 24);
    return hdr;
  }
  throw new Error(`Unsupported tuple: ${tuple}`);
}

function makeSyntheticBinary({
  tuple,
  kind = 'clec',
  version = PACKAGE_VERSION,
  target = null,
  profile = 'release',
  features = [],
  testHooks = false,
  rustcVersion = DEFAULT_RUSTC,
  cargoLockSha256 = DEFAULT_LOCK_SHA,
  omitIdentity = false,
  duplicateIdentity = false,
  headerOptions = {},
} = {}) {
  const meta = findTargetByTuple(tuple);
  const resolvedTarget = target ?? meta.rustTarget;
  const header = makeContainerHeader(tuple, headerOptions);
  if (omitIdentity) {
    return header;
  }
  const identityObj = {
    schemaVersion: 1,
    packageName: NATIVE_CRATE_NAME,
    packageVersion: version,
    artifactKind: kind,
    target: resolvedTarget,
    profile,
    features,
    testHooks,
    rustcVersion,
    cargoLockSha256,
  };
  const marker = Buffer.concat([
    IDENTITY_PREFIX,
    Buffer.from(JSON.stringify(identityObj), 'utf8'),
    IDENTITY_SUFFIX,
  ]);
  return duplicateIdentity
    ? Buffer.concat([header, marker, marker])
    : Buffer.concat([header, marker]);
}

function makeBoundReceipt(tuple, artifactMap, overrides = {}) {
  const meta = findTargetByTuple(tuple);
  const artifacts = {};
  for (const [slotKey, info] of Object.entries(artifactMap)) {
    const embedded = extractEmbeddedBuildIdentity(info.bytes);
    artifacts[slotKey] = {
      kind: embedded.artifactKind,
      binaryName: info.binaryName,
      bytes: info.bytes.length,
      sha256: sha256(info.bytes),
      embeddedMetadata: embedded,
    };
  }
  return {
    schemaVersion: 1,
    receiptKind: 'clec-build-receipt',
    trustModel: 'unsigned-local-build-receipt',
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    tuple: meta.tuple,
    rustTarget: meta.rustTarget,
    sourceCommit: DEFAULT_COMMIT,
    sourceDirty: false,
    cargoLockSha256: DEFAULT_LOCK_SHA,
    rustcVersion: DEFAULT_RUSTC,
    profile: 'release',
    features: [],
    testHooksIncluded: false,
    buildCommand: 'cargo +1.89.0 build --manifest-path native/Cargo.toml --locked --release --bins -j 2',
    hostBaseline: `${meta.platform}-${meta.arch}-synthetic`,
    artifacts,
    ...overrides,
  };
}

function makeFakeStagingPackage(root, tuple, payloadBytes, entryOverrides = {}) {
  const meta = findTargetByTuple(tuple);
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'payloads', tuple), { recursive: true });
  const payloadRel = `payloads/${tuple}/${meta.binaryName}`;
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
          platform: meta.platform,
          arch: meta.arch,
          rustTarget: meta.rustTarget,
          binaryName: meta.binaryName,
          libc: meta.libc,
          payloadPath: payloadRel,
          bytes: payloadBytes.length,
          sha256: sha256(payloadBytes),
          structuralIdentity: {
            containerFormat: meta.executableFormat,
            arch: meta.arch,
            executableType: 'synthetic',
            rustTarget: meta.rustTarget,
            packageVersion: PACKAGE_VERSION,
            features: [],
            testHooksIncluded: false,
          },
          ...entryOverrides,
        },
      },
    }),
  );
}

test('target matrix contains exactly the five declared tuples', () => {
  assert.deepEqual(
    TARGET_MATRIX.map((t) => [t.tuple, t.rustTarget, t.executableFormat, t.libc]),
    [
      ['darwin-arm64', 'aarch64-apple-darwin', 'macho-64', 'apple-dyld'],
      ['darwin-x64', 'x86_64-apple-darwin', 'macho-64', 'apple-dyld'],
      ['linux-x64', 'x86_64-unknown-linux-musl', 'elf-64', 'musl-static'],
      ['linux-arm64', 'aarch64-unknown-linux-musl', 'elf-64', 'musl-static'],
      ['win32-x64', 'x86_64-pc-windows-msvc', 'pe-64', 'msvc'],
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

test('executable container validation accepts all five target formats and rejects wrong format, arch, dylib/DLL, fat Mach-O, and interpreted ELF', () => {
  for (const meta of TARGET_MATRIX) {
    const buf = makeSyntheticBinary({ tuple: meta.tuple });
    const parsed = assertExecutableMatchesTarget(buf, meta);
    assert.equal(parsed.containerFormat, meta.executableFormat);
    assert.equal(parsed.arch, meta.arch);
  }

  assert.throws(() => inspectExecutableContainer(Buffer.alloc(0)), /non-empty/);
  assert.throws(() => inspectExecutableContainer(Buffer.from('#!/bin/sh\necho hi\n')), /Unrecognized/);

  const fatMachO = Buffer.alloc(64, 0);
  fatMachO.writeUInt32BE(0xcafebabe, 0);
  assert.throws(() => inspectExecutableContainer(fatMachO), /Universal\/Fat Mach-O/);

  const dylib = makeContainerHeader('darwin-arm64', { fileType: 6 });
  assert.throws(() => inspectExecutableContainer(dylib), /MH_EXECUTE/);

  const dll = makeContainerHeader('win32-x64', { characteristics: 0x2002 });
  assert.throws(() => inspectExecutableContainer(dll), /not a DLL/);

  const macArm = makeSyntheticBinary({ tuple: 'darwin-arm64' });
  for (const wrongTuple of ['darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']) {
    assert.throws(
      () => assertExecutableMatchesTarget(macArm, findTargetByTuple(wrongTuple)),
      /Executable format\/architecture mismatch/,
    );
  }

  for (const tuple of ['linux-x64', 'linux-arm64']) {
    for (const interp of ['/lib64/ld-linux-x86-64.so.2', '/lib/ld-musl-x86_64.so.1', '/custom/loader', '']) {
      const elf = makeContainerHeader(tuple, { interp });
      assert.throws(
        () => assertExecutableMatchesTarget(elf, findTargetByTuple(tuple)),
        /requires musl-static linkage/,
        `${tuple} must reject PT_INTERP ${JSON.stringify(interp)}`,
      );
    }
    const emptySegment = makeContainerHeader(tuple, { interp: '' });
    emptySegment.writeBigUInt64LE(0n, 96);
    assert.throws(
      () => assertExecutableMatchesTarget(emptySegment, findTargetByTuple(tuple)),
      /requires musl-static linkage/,
    );
  }
});

test('installer validates full target schema, executable format, non-test-hooks identity, checksums, and placeholder restoration', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'clec-install-unit-'));
  try {
    const pkgValid = join(tmp, 'valid');
    const payload = makeSyntheticBinary({ tuple: 'darwin-arm64' });
    makeFakeStagingPackage(pkgValid, 'darwin-arm64', payload);

    const receipt = installFromRoot(pkgValid, { platform: 'darwin', arch: 'arm64' });
    assert.equal(receipt.tuple, 'darwin-arm64');
    assert.equal(receipt.bytes, payload.length);
    assert.equal(receipt.sha256, sha256(payload));
    assert.deepEqual(readFileSync(join(pkgValid, 'bin', 'clec.exe')), payload);
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

    const mislabeledPkg = join(tmp, 'mislabeled');
    makeFakeStagingPackage(mislabeledPkg, 'darwin-arm64', payload, {
      platform: 'linux',
      arch: 'x64',
      rustTarget: 'x86_64-unknown-linux-musl',
      libc: 'musl-static',
    });
    assert.throws(
      () => installFromRoot(mislabeledPkg, { platform: 'darwin', arch: 'arm64' }),
      /Inventory metadata mismatch/,
    );
    assert.equal(readFileSync(join(mislabeledPkg, 'bin', 'clec.exe'))[0], 0);

    const nonNativePkg = join(tmp, 'non-native');
    makeFakeStagingPackage(nonNativePkg, 'darwin-arm64', Buffer.from('NOT A NATIVE BINARY 29 BYTES'));
    assert.throws(
      () => installFromRoot(nonNativePkg, { platform: 'darwin', arch: 'arm64' }),
      /Unrecognized or non-native executable container format/,
    );

    const hookPayload = makeSyntheticBinary({
      tuple: 'darwin-arm64',
      kind: 'clec_test_fixture',
      features: ['test-hooks'],
      testHooks: true,
    });
    const hookPkg = join(tmp, 'hook');
    makeFakeStagingPackage(hookPkg, 'darwin-arm64', hookPayload);
    assert.throws(
      () => installFromRoot(hookPkg, { platform: 'darwin', arch: 'arm64' }),
      /test-hooks/,
    );

    writeFileSync(
      join(pkgValid, 'payloads', 'darwin-arm64', 'clec'),
      Buffer.from('X'.repeat(payload.length)),
    );
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

test('stageRelease validates bound receipts, rejects incomplete/wrong/hook/unknown inputs, and repacks deterministically across all five tuples', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'clec-stage-unit-'));
  try {
    const fullTargets = {};
    for (const meta of TARGET_MATRIX) {
      const dir = join(tmp, 'bins', meta.tuple);
      mkdirSync(dir, { recursive: true });
      const clecBytes = makeSyntheticBinary({ tuple: meta.tuple, kind: 'clec' });
      const pubBytes = makeSyntheticBinary({ tuple: meta.tuple, kind: 'clec-publish' });
      const valBytes = makeSyntheticBinary({ tuple: meta.tuple, kind: 'clec-validate' });
      const clecPath = join(dir, meta.binaryName);
      const pubPath = join(dir, meta.maintainerBinaries[0]);
      const valPath = join(dir, meta.maintainerBinaries[1]);
      writeFileSync(clecPath, clecBytes);
      writeFileSync(pubPath, pubBytes);
      writeFileSync(valPath, valBytes);
      chmodSync(clecPath, 0o755);
      chmodSync(pubPath, 0o755);
      chmodSync(valPath, 0o755);

      const receiptPath = join(dir, 'build-receipt.json');
      writeFileSync(
        receiptPath,
        JSON.stringify(
          makeBoundReceipt(meta.tuple, {
            clec: { bytes: clecBytes, binaryName: meta.binaryName },
            clecPublish: { bytes: pubBytes, binaryName: meta.maintainerBinaries[0] },
            clecValidate: { bytes: valBytes, binaryName: meta.maintainerBinaries[1] },
          }),
        ),
      );
      fullTargets[meta.tuple] = {
        clec: clecPath,
        clecPublish: pubPath,
        clecValidate: valPath,
        buildReceipt: receiptPath,
      };
    }

    const fullInput = join(tmp, 'full.json');
    writeFileSync(fullInput, JSON.stringify({ targets: fullTargets }));
    const fullOut1 = join(tmp, 'full-1');
    const fullOut2 = join(tmp, 'full-2');
    const fullRes1 = stageRelease({ input: fullInput, output: fullOut1 }, CLI_ROOT);
    const fullRes2 = stageRelease({ input: fullInput, output: fullOut2 }, CLI_ROOT);
    assert.equal(fullRes1.complete, true);
    assert.equal(fullRes1.publishable, false);
    assert.equal(fullRes1.sha256sumsSha256, fullRes2.sha256sumsSha256);

    const fullInv = JSON.parse(readFileSync(join(fullOut1, 'inventory.json'), 'utf8'));
    assert.equal(fullInv.complete, true);
    assert.equal(fullInv.publishable, false);
    assert.equal(fullInv.targets['linux-x64'].executionEvidence.status, 'unverified');
    assert.equal(fullInv.targets['linux-x64'].structuralIdentity.containerFormat, 'elf-64');
    assert.equal(fullInv.targets['linux-x64'].structuralIdentity.testHooksIncluded, false);

    const partialInput = join(tmp, 'partial.json');
    writeFileSync(
      partialInput,
      JSON.stringify({ targets: { 'darwin-arm64': fullTargets['darwin-arm64'] } }),
    );
    assert.throws(
      () => stageRelease({ input: partialInput, output: join(tmp, 'prod-incomplete') }, CLI_ROOT),
      /Refusing incomplete production staging/,
    );
    assert.deepEqual(readdirSync(join(tmp, 'prod-incomplete')), []);

    const partialOut = join(tmp, 'partial-ok');
    const partialRes = stageRelease(
      { input: partialInput, output: partialOut, allowPartial: true },
      CLI_ROOT,
    );
    assert.equal(partialRes.complete, false);
    assert.equal(partialRes.publishable, false);

    const badCliOut = join(tmp, 'bad-cli');
    assert.throws(
      () =>
        stageRelease(
          {
            input: partialInput,
            output: badCliOut,
            allowPartial: true,
            sourceCommit: 'unknown',
          },
          CLI_ROOT,
        ),
      /Invalid or unknown value for source-commit/,
    );
    assert.deepEqual(readdirSync(badCliOut), []);

    const wrongCommitOut = join(tmp, 'wrong-commit');
    assert.throws(
      () =>
        stageRelease(
          {
            input: partialInput,
            output: wrongCommitOut,
            allowPartial: true,
            sourceCommit: 'b'.repeat(40),
          },
          CLI_ROOT,
        ),
      /contradicts bound build receipt/,
    );

    const dirtyReceiptPath = join(tmp, 'dirty-receipt.json');
    const armTarget = fullTargets['darwin-arm64'];
    const dirtyReceipt = JSON.parse(readFileSync(armTarget.buildReceipt, 'utf8'));
    dirtyReceipt.sourceDirty = true;
    writeFileSync(dirtyReceiptPath, JSON.stringify(dirtyReceipt));
    const dirtyFull = {
      targets: { ...fullTargets, 'darwin-arm64': { ...armTarget, buildReceipt: dirtyReceiptPath } },
    };
    const dirtyInput = join(tmp, 'dirty-full.json');
    writeFileSync(dirtyInput, JSON.stringify(dirtyFull));
    assert.throws(
      () => stageRelease({ input: dirtyInput, output: join(tmp, 'dirty-prod') }, CLI_ROOT),
      /dirty git working tree/,
    );

    const renamedHook = join(tmp, 'completely-innocuous-name');
    const hookBytes = makeSyntheticBinary({
      tuple: 'darwin-arm64',
      kind: 'clec_test_fixture',
      features: ['test-hooks'],
      testHooks: true,
    });
    writeFileSync(renamedHook, hookBytes);
    const hookReceiptPath = join(tmp, 'hook-receipt.json');
    writeFileSync(
      hookReceiptPath,
      JSON.stringify(
        makeBoundReceipt(
          'darwin-arm64',
          { clec: { bytes: hookBytes, binaryName: 'clec' } },
          { features: ['test-hooks'], testHooksIncluded: true },
        ),
      ),
    );
    const hookInput = join(tmp, 'hook.json');
    writeFileSync(
      hookInput,
      JSON.stringify({
        targets: { 'darwin-arm64': { clec: renamedHook, buildReceipt: hookReceiptPath } },
      }),
    );
    const hookOut = join(tmp, 'hook-out');
    assert.throws(
      () => stageRelease({ input: hookInput, output: hookOut, allowPartial: true }, CLI_ROOT),
      /testHooksIncluded must be false|test-hooks/,
    );
    assert.equal(existsSync(join(hookOut, 'clec-cli-1.0.0-dev.0.tgz')), false);

    const forgedMaintainer = join(tmp, 'forged-pub');
    const hookPubBytes = makeSyntheticBinary({
      tuple: 'darwin-arm64',
      kind: 'clec-publish',
      features: ['test-hooks'],
      testHooks: true,
    });
    writeFileSync(forgedMaintainer, hookPubBytes);
    const maintHookInput = join(tmp, 'maint-hook.json');
    writeFileSync(
      maintHookInput,
      JSON.stringify({
        targets: {
          'darwin-arm64': {
            ...armTarget,
            clecPublish: forgedMaintainer,
          },
        },
      }),
    );
    assert.throws(
      () =>
        stageRelease(
          { input: maintHookInput, output: join(tmp, 'maint-hook-out'), allowPartial: true },
          CLI_ROOT,
        ),
      /test-hooks/,
    );

    const dupMarkerBin = join(tmp, 'dup-marker');
    writeFileSync(
      dupMarkerBin,
      Buffer.concat([
        makeSyntheticBinary({ tuple: 'darwin-arm64', duplicateIdentity: true }),
      ]),
    );
    const dupInput = join(tmp, 'dup.json');
    writeFileSync(
      dupInput,
      JSON.stringify({
        targets: {
          'darwin-arm64': { clec: dupMarkerBin, buildReceipt: armTarget.buildReceipt },
        },
      }),
    );
    assert.throws(
      () => stageRelease({ input: dupInput, output: join(tmp, 'dup-out'), allowPartial: true }, CLI_ROOT),
      /duplicate CLEC_BUILD_IDENTITY_V1/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const REAL_MSRV_DIR = join(REPO_ROOT, '.cache', 'stage6a-v2', 'target-msrv');
const REAL_CLEC = join(REAL_MSRV_DIR, 'release', 'clec');
const REAL_HOOK = join(REAL_MSRV_DIR, 'release', 'examples', 'clec_test_fixture');

test(
  'real darwin-arm64 MSRV binaries pass bound receipt staging and reject wrong tuple, slot swap, and renamed clec_test_fixture',
  { skip: !existsSync(REAL_CLEC) || !existsSync(REAL_HOOK) },
  () => {
    const tmp = mkdtempSync(join(tmpdir(), 'clec-real-admission-'));
    try {
      const receiptPath = join(tmp, 'darwin-arm64-receipt.json');
      const receipt = captureBuildReceipt({
        tuple: 'darwin-arm64',
        targetDir: REAL_MSRV_DIR,
        out: receiptPath,
        repoRoot: REPO_ROOT,
        toolchain: '1.89.0',
        buildCommand:
          'cargo +1.89.0 build --manifest-path native/Cargo.toml --locked --release --bins -j 2',
        hostBaseline: 'darwin-arm64',
      });
      assert.equal(receipt.testHooksIncluded, false);
      assert.deepEqual(receipt.features, []);

      const validInput = join(tmp, 'valid.json');
      writeFileSync(
        validInput,
        JSON.stringify({
          targets: {
            'darwin-arm64': {
              clec: REAL_CLEC,
              clecPublish: join(REAL_MSRV_DIR, 'release', 'clec-publish'),
              clecValidate: join(REAL_MSRV_DIR, 'release', 'clec-validate'),
              buildReceipt: receiptPath,
              executionEvidence: 'verified-local',
            },
          },
        }),
      );
      const out1 = join(tmp, 'out1');
      const out2 = join(tmp, 'out2');
      const res1 = stageRelease({ input: validInput, output: out1, allowPartial: true }, CLI_ROOT);
      const res2 = stageRelease({ input: validInput, output: out2, allowPartial: true }, CLI_ROOT);
      assert.equal(res1.sha256sumsSha256, res2.sha256sumsSha256);

      const renamedHook = join(tmp, 'clec');
      copyFileSync(REAL_HOOK, renamedHook);
      const hookBytes = readFileSync(renamedHook);
      const forgedHookReceiptPath = join(tmp, 'forged-hook-receipt.json');
      const forgedHookReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      forgedHookReceipt.artifacts.clec.bytes = hookBytes.length;
      forgedHookReceipt.artifacts.clec.sha256 = sha256(hookBytes);
      forgedHookReceipt.artifacts.clec.embeddedMetadata = extractEmbeddedBuildIdentity(hookBytes);
      writeFileSync(forgedHookReceiptPath, JSON.stringify(forgedHookReceipt));

      const hookInput = join(tmp, 'hook.json');
      writeFileSync(
        hookInput,
        JSON.stringify({
          targets: {
            'darwin-arm64': {
              clec: renamedHook,
              buildReceipt: forgedHookReceiptPath,
            },
          },
        }),
      );
      assert.throws(
        () => stageRelease({ input: hookInput, output: join(tmp, 'hook-out'), allowPartial: true }, CLI_ROOT),
        /test-hooks/,
      );

      const swappedMaintInput = join(tmp, 'swap.json');
      writeFileSync(
        swappedMaintInput,
        JSON.stringify({
          targets: {
            'darwin-arm64': {
              clec: join(REAL_MSRV_DIR, 'release', 'clec-publish'),
              buildReceipt: receiptPath,
            },
          },
        }),
      );
      assert.throws(
        () =>
          stageRelease(
            { input: swappedMaintInput, output: join(tmp, 'swap-out'), allowPartial: true },
            CLI_ROOT,
          ),
        /artifactKind mismatch/,
      );

      for (const wrongTuple of ['darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']) {
        const wrongMeta = findTargetByTuple(wrongTuple);
        const wrongReceiptPath = join(tmp, `forged-${wrongTuple}-receipt.json`);
        const wrongReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        wrongReceipt.tuple = wrongMeta.tuple;
        wrongReceipt.rustTarget = wrongMeta.rustTarget;
        writeFileSync(wrongReceiptPath, JSON.stringify(wrongReceipt));

        const wrongInput = join(tmp, `wrong-${wrongTuple}.json`);
        writeFileSync(
          wrongInput,
          JSON.stringify({
            targets: {
              [wrongTuple]: {
                clec: REAL_CLEC,
                buildReceipt: wrongReceiptPath,
              },
            },
          }),
        );
        assert.throws(
          () =>
            stageRelease(
              { input: wrongInput, output: join(tmp, `wrong-${wrongTuple}-out`), allowPartial: true },
              CLI_ROOT,
            ),
          /Executable format\/architecture mismatch/,
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test(
  'real binary inspection against unrelated checkout, unexecuted command, and stale new-HEAD checkout never promotes build provenance',
  { skip: !existsSync(REAL_CLEC) },
  () => {
    const tmp = mkdtempSync(join(tmpdir(), 'clec-misattribution-'));
    try {
      const unrelatedRepo = join(tmp, 'unrelated-repo');
      mkdirSync(join(unrelatedRepo, 'native'), { recursive: true });
      copyFileSync(join(REPO_ROOT, 'native', 'Cargo.lock'), join(unrelatedRepo, 'native', 'Cargo.lock'));
      writeFileSync(join(unrelatedRepo, 'native', 'Cargo.toml'), '[package]\nname = "clec-native"\nversion = "1.0.0-dev.0"\n');
      execFileSync('git', ['-C', unrelatedRepo, 'init']);
      execFileSync('git', ['-C', unrelatedRepo, 'add', '.']);
      execFileSync('git', ['-C', unrelatedRepo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'unrelated root without build.rs']);
      const unrelatedCommit = execFileSync('git', ['-C', unrelatedRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

      const receiptPath = join(tmp, 'inspected-receipt.json');
      const receipt = captureBuildReceipt({
        tuple: 'darwin-arm64',
        repoRoot: unrelatedRepo,
        clec: REAL_CLEC,
        toolchain: '1.89.0',
        buildCommand: 'this command was never executed',
        hostBaseline: 'darwin-arm64',
        out: receiptPath,
      });

      assert.equal(receipt.schemaVersion, 2);
      assert.equal(receipt.receiptKind, 'clec-inspected-prebuilt-receipt');
      assert.equal('sourceCommit' in receipt, false);
      assert.equal('sourceDirty' in receipt, false);
      assert.equal('buildCommand' in receipt, false);
      assert.equal(receipt.provenance.source.status, 'not_verified_unknown');
      assert.equal(receipt.provenance.buildInvocation.status, 'not_verified_unknown');
      assert.equal(receipt.captureObservation.observedGit.commit, unrelatedCommit);
      assert.equal(receipt.captureObservation.observedGit.dirty, false);
      assert.equal(receipt.captureObservation.declaredBuildCommand, 'this command was never executed');

      const stageInput = join(tmp, 'stage-input.json');
      writeFileSync(
        stageInput,
        JSON.stringify({
          targets: { 'darwin-arm64': { clec: REAL_CLEC, buildReceipt: receiptPath } },
        }),
      );
      const stagedOut = join(tmp, 'staged');
      stageRelease({ input: stageInput, output: stagedOut, allowPartial: true }, CLI_ROOT);

      const provenance = JSON.parse(readFileSync(join(stagedOut, 'provenance.json'), 'utf8'));
      const inventory = JSON.parse(readFileSync(join(stagedOut, 'inventory.json'), 'utf8'));
      assert.equal(provenance.schemaVersion, 2);
      assert.equal(provenance.publishable, false);
      assert.equal(provenance.provenanceClassification, 'inspected-prebuilt');
      assert.equal(provenance.provenance.source.status, 'not_verified_unknown');
      assert.equal(provenance.provenance.buildInvocation.status, 'not_verified_unknown');
      assert.equal('sourceCommit' in provenance, false);
      assert.equal('buildCommand' in provenance, false);
      assert.equal(inventory.schemaVersion, 2);
      assert.equal(inventory.targets['darwin-arm64'].provenance.source.status, 'not_verified_unknown');
      assert.equal(inventory.targets['darwin-arm64'].provenance.buildInvocation.status, 'not_verified_unknown');

      writeFileSync(join(unrelatedRepo, 'README.md'), 'new head same Cargo.lock\n');
      execFileSync('git', ['-C', unrelatedRepo, 'add', 'README.md']);
      execFileSync('git', ['-C', unrelatedRepo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'new head same lock']);
      const newHeadCommit = execFileSync('git', ['-C', unrelatedRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const staleReceipt = captureBuildReceipt({
        tuple: 'darwin-arm64',
        repoRoot: unrelatedRepo,
        clec: REAL_CLEC,
        toolchain: '1.89.0',
      });
      assert.equal(staleReceipt.receiptKind, 'clec-inspected-prebuilt-receipt');
      assert.equal(staleReceipt.provenance.source.status, 'not_verified_unknown');
      assert.equal(staleReceipt.captureObservation.observedGit.commit, newHeadCommit);

      assert.throws(
        () =>
          captureBuildReceipt({
            tuple: 'darwin-arm64',
            repoRoot: unrelatedRepo,
            clec: REAL_CLEC,
            buildCommand: 'unknown',
          }),
        /Invalid or unknown value/,
      );

      assert.throws(
        () =>
          stageRelease(
            {
              input: stageInput,
              output: join(tmp, 'cli-override-fail'),
              allowPartial: true,
              sourceCommit: unrelatedCommit,
            },
            CLI_ROOT,
          ),
        /inspected-prebuilt|not_verified_unknown/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test('controlled --run-build establishes git source and executed cargo argv while rejecting path/command overrides, build failures, and mid-build checkout mutation', () => {
  const hostMeta = findTargetByPlatformArch(process.platform, process.arch);
  assert.ok(hostMeta, `Expected supported host target for ${process.platform}-${process.arch}`);
  const tmp = mkdtempSync(join(tmpdir(), 'clec-controlled-build-'));
  try {
    const repo = join(tmp, 'repo');
    const nativeDir = join(repo, 'native');
    mkdirSync(join(nativeDir, 'src', 'bin'), { recursive: true });

    writeFileSync(
      join(nativeDir, 'Cargo.toml'),
      `[package]
name = "${NATIVE_CRATE_NAME}"
version = "${PACKAGE_VERSION}"
edition = "2021"

[lib]
name = "clec_core"
path = "src/lib.rs"

[[bin]]
name = "clec"
path = "src/main.rs"

[[bin]]
name = "clec-publish"
path = "src/bin/clec-publish.rs"

[[bin]]
name = "clec-validate"
path = "src/bin/clec-validate.rs"
`,
    );
    writeFileSync(
      join(nativeDir, 'Cargo.lock'),
      `# This file is automatically @generated by Cargo.\nversion = 3\n\n[[package]]\nname = "${NATIVE_CRATE_NAME}"\nversion = "${PACKAGE_VERSION}"\n`,
    );
    copyFileSync(join(REPO_ROOT, 'native', 'build.rs'), join(nativeDir, 'build.rs'));
    copyFileSync(join(REPO_ROOT, 'native', 'src', 'build_identity.rs'), join(nativeDir, 'src', 'build_identity.rs'));
    writeFileSync(join(nativeDir, 'src', 'lib.rs'), 'pub mod build_identity;\n');
    const mkBinSrc = (kind) => `fn main() {\n  clec_core::build_identity::retain(clec_core::clec_build_identity!("${kind}"));\n}\n`;
    writeFileSync(join(nativeDir, 'src', 'main.rs'), mkBinSrc('clec'));
    writeFileSync(join(nativeDir, 'src', 'bin', 'clec-publish.rs'), mkBinSrc('clec-publish'));
    writeFileSync(join(nativeDir, 'src', 'bin', 'clec-validate.rs'), mkBinSrc('clec-validate'));

    execFileSync('git', ['-C', repo, 'init']);
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init minimal crate']);
    const headCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const targetDir = join(tmp, 'target');
    const receiptPath = join(tmp, 'controlled-receipt.json');
    const receipt = captureBuildReceipt({
      tuple: hostMeta.tuple,
      targetDir,
      repoRoot: repo,
      runBuild: true,
      toolchain: '1.89.0',
      hostBaseline: `${hostMeta.tuple}-test`,
      out: receiptPath,
    });

    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.receiptKind, 'clec-controlled-build-receipt');
    assert.equal('captureObservation' in receipt, false);
    assert.equal(receipt.provenance.source.status, 'established_local_git_checkout');
    assert.equal(receipt.provenance.source.sourceCommit, headCommit);
    assert.equal(receipt.provenance.source.sourceDirty, false);
    assert.equal(receipt.provenance.buildInvocation.status, 'established_local_cargo_execution');
    assert.equal(receipt.provenance.buildInvocation.executable, 'cargo');
    assert.ok(receipt.provenance.buildInvocation.argv.includes('--locked'));
    assert.ok(receipt.provenance.buildInvocation.argv.includes('--release'));
    assert.equal(receipt.provenance.buildInvocation.hostBaseline, `${hostMeta.tuple}-test`);

    const builtClec = join(targetDir, 'release', hostMeta.binaryName);
    const builtPub = join(targetDir, 'release', hostMeta.maintainerBinaries[0]);
    const builtVal = join(targetDir, 'release', hostMeta.maintainerBinaries[1]);
    assert.equal(receipt.artifacts.clec.sha256, sha256(readFileSync(builtClec)));

    const stageInput = join(tmp, 'controlled-input.json');
    writeFileSync(
      stageInput,
      JSON.stringify({
        targets: {
          [hostMeta.tuple]: {
            clec: builtClec,
            clecPublish: builtPub,
            clecValidate: builtVal,
            buildReceipt: receiptPath,
          },
        },
      }),
    );
    const stagedDir = join(tmp, 'staged-controlled');
    stageRelease({ input: stageInput, output: stagedDir, allowPartial: true }, CLI_ROOT);
    const prov = JSON.parse(readFileSync(join(stagedDir, 'provenance.json'), 'utf8'));
    assert.equal(prov.provenanceClassification, 'controlled-executed-build');
    assert.equal(prov.provenance.source.status, 'established_local_git_checkout');
    assert.equal(prov.provenance.source.sourceCommit, headCommit);
    assert.equal(prov.provenance.buildInvocation.status, 'established_local_cargo_execution');

    assert.throws(
      () =>
        captureBuildReceipt({
          tuple: hostMeta.tuple,
          targetDir,
          repoRoot: repo,
          runBuild: true,
          clec: builtClec,
        }),
      /Cannot override/,
    );
    assert.throws(
      () =>
        captureBuildReceipt({
          tuple: hostMeta.tuple,
          targetDir,
          repoRoot: repo,
          runBuild: true,
          buildCommand: 'custom fake command',
        }),
      /Cannot combine --run-build with --build-command/,
    );

    const buildRsOrig = readFileSync(join(nativeDir, 'build.rs'), 'utf8');
    writeFileSync(
      join(nativeDir, 'build.rs'),
      `${buildRsOrig.replace('fn main() {', 'fn main() {\n    std::fs::write("mid-build-dirty.txt", "changed").unwrap();')}`,
    );
    execFileSync('git', ['-C', repo, 'add', 'native/build.rs']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'mutate checkout during build']);
    assert.throws(
      () =>
        captureBuildReceipt({
          tuple: hostMeta.tuple,
          targetDir,
          repoRoot: repo,
          runBuild: true,
          toolchain: '1.89.0',
        }),
      /Source working tree changed during controlled build/,
    );

    writeFileSync(join(nativeDir, 'src', 'main.rs'), 'this is invalid rust syntax;\n');
    assert.throws(() =>
      captureBuildReceipt({
        tuple: hostMeta.tuple,
        targetDir,
        repoRoot: repo,
        runBuild: true,
        toolchain: '1.89.0',
      }),
    );
    assert.equal(existsSync(builtClec), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('admitTargetArtifacts and installer reject interpreted/malformed PT_INTERP ELFs, legacy receipt shapes, and promoted unknown provenance', async () => {
  const { admitTargetArtifacts } = await import('../scripts/artifact-admission.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'clec-union-boundary-'));
  try {
    for (const tuple of ['linux-x64', 'linux-arm64']) {
      const meta = findTargetByTuple(tuple);
      for (const interp of ['/lib/ld-musl-x86_64.so.1', '/custom/loader', '']) {
        const binBytes = makeSyntheticBinary({ tuple, headerOptions: { interp } });
        const binPath = join(tmp, `${tuple}-${interp.length}.bin`);
        const receiptPath = join(tmp, `${tuple}-${interp.length}.receipt.json`);
        writeFileSync(binPath, binBytes);
        writeFileSync(
          receiptPath,
          JSON.stringify({
            schemaVersion: 2,
            receiptKind: 'clec-inspected-prebuilt-receipt',
            trustModel: 'unsigned-inspected-prebuilt-receipt',
            packageName: PACKAGE_NAME,
            packageVersion: PACKAGE_VERSION,
            tuple: meta.tuple,
            rustTarget: meta.rustTarget,
            provenance: {
              source: { status: 'not_verified_unknown', reason: 'inspected_prebuilt_without_controlled_build' },
              buildInvocation: { status: 'not_verified_unknown', reason: 'inspected_prebuilt_without_controlled_build' },
            },
            captureObservation: {
              observedGit: null,
              declaredBuildCommand: null,
              declaredHostBaseline: null,
            },
            verifiedEmbeddedMetadata: {
              cargoLockSha256: DEFAULT_LOCK_SHA,
              rustcVersion: DEFAULT_RUSTC,
              profile: 'release',
              features: [],
              testHooksIncluded: false,
            },
            artifacts: {
              clec: {
                kind: 'clec',
                binaryName: meta.binaryName,
                bytes: binBytes.length,
                sha256: sha256(binBytes),
                embeddedMetadata: extractEmbeddedBuildIdentity(binBytes),
              },
            },
          }),
        );
        assert.throws(
          () =>
            admitTargetArtifacts(
              meta,
              { clec: binPath, buildReceipt: receiptPath },
              { packageVersion: PACKAGE_VERSION, allowPartial: false },
            ),
          /requires musl-static linkage/,
        );
      }

      const hdr = makeContainerHeader(tuple, { interp: '' });
      hdr.writeBigUInt64LE(0n, 96);
      const id = extractEmbeddedBuildIdentity(makeSyntheticBinary({ tuple }));
      const zeroLenElf = Buffer.concat([
        hdr,
        IDENTITY_PREFIX,
        Buffer.from(JSON.stringify(id), 'utf8'),
        IDENTITY_SUFFIX,
      ]);
      const zeroPath = join(tmp, `${tuple}-zero.bin`);
      const zeroReceiptPath = join(tmp, `${tuple}-zero.receipt.json`);
      writeFileSync(zeroPath, zeroLenElf);
      writeFileSync(
        zeroReceiptPath,
        JSON.stringify({
          schemaVersion: 2,
          receiptKind: 'clec-inspected-prebuilt-receipt',
          trustModel: 'unsigned-inspected-prebuilt-receipt',
          packageName: PACKAGE_NAME,
          packageVersion: PACKAGE_VERSION,
          tuple: meta.tuple,
          rustTarget: meta.rustTarget,
          provenance: {
            source: { status: 'not_verified_unknown', reason: 'inspected_prebuilt_without_controlled_build' },
            buildInvocation: { status: 'not_verified_unknown', reason: 'inspected_prebuilt_without_controlled_build' },
          },
          captureObservation: {
            observedGit: null,
            declaredBuildCommand: null,
            declaredHostBaseline: null,
          },
          verifiedEmbeddedMetadata: {
            cargoLockSha256: DEFAULT_LOCK_SHA,
            rustcVersion: DEFAULT_RUSTC,
            profile: 'release',
            features: [],
            testHooksIncluded: false,
          },
          artifacts: {
            clec: {
              kind: 'clec',
              binaryName: meta.binaryName,
              bytes: zeroLenElf.length,
              sha256: sha256(zeroLenElf),
              embeddedMetadata: id,
            },
          },
        }),
      );
      assert.throws(
        () =>
          admitTargetArtifacts(
            meta,
            { clec: zeroPath, buildReceipt: zeroReceiptPath },
            { packageVersion: PACKAGE_VERSION, allowPartial: false },
          ),
        /requires musl-static linkage/,
      );
    }

    const macMeta = findTargetByTuple('darwin-arm64');
    const macBytes = makeSyntheticBinary({ tuple: 'darwin-arm64' });
    const macPath = join(tmp, 'clec');
    writeFileSync(macPath, macBytes);
    const legacyReceiptPath = join(tmp, 'legacy-v1.json');
    writeFileSync(
      legacyReceiptPath,
      JSON.stringify(makeBoundReceipt('darwin-arm64', { clec: { bytes: macBytes, binaryName: 'clec' } })),
    );
    assert.throws(
      () =>
        admitTargetArtifacts(
          macMeta,
          { clec: macPath, buildReceipt: legacyReceiptPath },
          { packageVersion: PACKAGE_VERSION, allowPartial: true },
        ),
      /schemaVersion|legacy|clec-inspected-prebuilt-receipt/,
    );

    const fakePromotedReceiptPath = join(tmp, 'fake-promoted.json');
    writeFileSync(
      fakePromotedReceiptPath,
      JSON.stringify({
        schemaVersion: 2,
        receiptKind: 'clec-inspected-prebuilt-receipt',
        trustModel: 'unsigned-inspected-prebuilt-receipt',
        packageName: PACKAGE_NAME,
        packageVersion: PACKAGE_VERSION,
        tuple: 'darwin-arm64',
        rustTarget: 'aarch64-apple-darwin',
        provenance: {
          source: { status: 'established_local_git_checkout', sourceCommit: DEFAULT_COMMIT, sourceDirty: false },
          buildInvocation: { status: 'not_verified_unknown', reason: 'inspected_prebuilt_without_controlled_build' },
        },
        captureObservation: { observedGit: null, declaredBuildCommand: null, declaredHostBaseline: null },
        verifiedEmbeddedMetadata: {
          cargoLockSha256: DEFAULT_LOCK_SHA,
          rustcVersion: DEFAULT_RUSTC,
          profile: 'release',
          features: [],
          testHooksIncluded: false,
        },
        artifacts: {
          clec: {
            kind: 'clec',
            binaryName: 'clec',
            bytes: macBytes.length,
            sha256: sha256(macBytes),
            embeddedMetadata: extractEmbeddedBuildIdentity(macBytes),
          },
        },
      }),
    );
    assert.throws(
      () =>
        admitTargetArtifacts(
          macMeta,
          { clec: macPath, buildReceipt: fakePromotedReceiptPath },
          { packageVersion: PACKAGE_VERSION, allowPartial: true },
        ),
      /not_verified_unknown/,
    );

    const badInvPkg = join(tmp, 'bad-inv-pkg');
    makeFakeStagingPackage(badInvPkg, 'darwin-arm64', macBytes);
    const badInv = JSON.parse(readFileSync(join(badInvPkg, 'inventory.json'), 'utf8'));
    badInv.schemaVersion = 2;
    badInv.targets['darwin-arm64'].provenance = {
      source: { status: 'unknown', reason: 'invalid' },
      buildInvocation: { status: 'not_verified_unknown', reason: 'inspected_prebuilt_without_controlled_build' },
    };
    writeFileSync(join(badInvPkg, 'inventory.json'), JSON.stringify(badInv));
    assert.throws(
      () => installFromRoot(badInvPkg, { platform: 'darwin', arch: 'arm64' }),
      /provenance|status/,
    );
    assert.equal(readFileSync(join(badInvPkg, 'bin', 'clec.exe'))[0], 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
