import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTROLLED_BUILD_RECEIPT_KIND,
  ESTABLISHED_BUILD,
  ESTABLISHED_SOURCE,
  INSPECTED_PREBUILT_RECEIPT_KIND,
  NOT_VERIFIED_UNKNOWN,
  RECEIPT_SCHEMA_VERSION,
  assertExecutableMatchesTarget,
  assertNonEmptyKnownString,
  extractEmbeddedBuildIdentity,
  readRegularFile,
  sha256Hex,
} from './artifact-admission.mjs';
import { PACKAGE_NAME, PACKAGE_VERSION, findTargetByTuple } from './targets.mjs';

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const opts = {
    tuple: null,
    targetDir: null,
    out: null,
    repoRoot: undefined,
    runBuild: false,
    toolchain: null,
    cargoLockPath: null,
    buildCommand: null,
    hostBaseline: null,
    clec: null,
    clecPublish: null,
    clecValidate: null,
    requireMaintainer: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tuple') {
      opts.tuple = argv[++i];
    } else if (arg === '--target-dir') {
      opts.targetDir = argv[++i];
    } else if (arg === '--out') {
      opts.out = argv[++i];
    } else if (arg === '--repo-root') {
      opts.repoRoot = argv[++i];
    } else if (arg === '--run-build') {
      opts.runBuild = true;
    } else if (arg === '--toolchain') {
      opts.toolchain = argv[++i];
    } else if (arg === '--cargo-lock') {
      opts.cargoLockPath = argv[++i];
    } else if (arg === '--build-command') {
      opts.buildCommand = argv[++i];
    } else if (arg === '--host-baseline') {
      opts.hostBaseline = argv[++i];
    } else if (arg === '--clec') {
      opts.clec = argv[++i];
    } else if (arg === '--clec-publish') {
      opts.clecPublish = argv[++i];
    } else if (arg === '--clec-validate') {
      opts.clecValidate = argv[++i];
    } else if (arg === '--consumer-only') {
      opts.requireMaintainer = false;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!opts.tuple || (!opts.targetDir && !opts.clec) || !opts.out) {
    throw new Error(
      'Usage: build-receipt.mjs --tuple <tuple> (--target-dir <dir> | --clec <path>) --out <receipt.json> [--run-build] [--toolchain <ver>] [--cargo-lock <path>] [--build-command <cmd>] [--host-baseline <str>] [--repo-root <dir>]',
    );
  }
  return opts;
}

function execText(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function readGitState(repoRoot) {
  const commit = execText('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], repoRoot);
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Unexpected git HEAD SHA: ${commit}`);
  }
  const statusRaw = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\r?\n$/, '');
  return {
    commit,
    dirty: statusRaw.length > 0,
    statusRaw,
  };
}

function inspectArtifacts(slotDefs, targetMeta, expectedRustcVersion, expectedCargoLockSha256) {
  const artifacts = {};
  let referenceIdentity = null;

  for (const slot of slotDefs) {
    const bytes = readRegularFile(slot.path, { nonEmpty: true });
    assertExecutableMatchesTarget(bytes, targetMeta);
    const embedded = extractEmbeddedBuildIdentity(bytes);
    if (embedded.artifactKind !== slot.expectedKind) {
      throw new Error(
        `Artifact ${slot.path} embedded artifactKind '${embedded.artifactKind}' != '${slot.expectedKind}'.`,
      );
    }
    if (embedded.packageVersion !== PACKAGE_VERSION) {
      throw new Error(
        `Artifact ${slot.path} packageVersion '${embedded.packageVersion}' != '${PACKAGE_VERSION}'.`,
      );
    }
    if (embedded.target !== targetMeta.rustTarget) {
      throw new Error(
        `Artifact ${slot.path} embedded target '${embedded.target}' != '${targetMeta.rustTarget}'.`,
      );
    }
    if (expectedCargoLockSha256 && embedded.cargoLockSha256 !== expectedCargoLockSha256) {
      throw new Error(
        `Artifact ${slot.path} embedded cargoLockSha256 '${embedded.cargoLockSha256}' != '${expectedCargoLockSha256}'.`,
      );
    }
    if (expectedRustcVersion && embedded.rustcVersion !== expectedRustcVersion) {
      throw new Error(
        `Artifact ${slot.path} embedded rustcVersion '${embedded.rustcVersion}' != '${expectedRustcVersion}'.`,
      );
    }
    if (referenceIdentity === null) {
      referenceIdentity = embedded;
    } else if (
      referenceIdentity.profile !== embedded.profile ||
      referenceIdentity.testHooks !== embedded.testHooks ||
      referenceIdentity.rustcVersion !== embedded.rustcVersion ||
      referenceIdentity.cargoLockSha256 !== embedded.cargoLockSha256 ||
      JSON.stringify(referenceIdentity.features) !== JSON.stringify(embedded.features)
    ) {
      throw new Error(`Artifact ${slot.path} build identity disagrees with clec binary.`);
    }

    artifacts[slot.key] = {
      kind: embedded.artifactKind,
      binaryName: slot.binaryName,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      embeddedMetadata: embedded,
    };
  }

  return { artifacts, referenceIdentity };
}

function writeReceiptIfRequested(out, receipt) {
  if (out) {
    const outPath = resolve(out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  }
  return receipt;
}

export function captureBuildReceipt(opts) {
  const targetMeta = findTargetByTuple(opts.tuple);
  if (!targetMeta) {
    throw new Error(`Unknown target tuple: ${opts.tuple}`);
  }
  const targetDir = opts.targetDir ? resolve(opts.targetDir) : null;
  const toolchainArgs = opts.toolchain ? [`+${opts.toolchain}`] : [];

  if (opts.runBuild) {
    if (!targetDir) {
      throw new Error('--run-build requires --target-dir.');
    }
    if (opts.clec || opts.clecPublish || opts.clecValidate) {
      throw new Error(
        'Cannot override --clec, --clec-publish, or --clec-validate when --run-build is enabled; controlled builds bind strictly to outputs produced in --target-dir.',
      );
    }
    if (opts.buildCommand !== undefined && opts.buildCommand !== null) {
      throw new Error(
        'Cannot combine --run-build with --build-command; controlled builds record the exact executed cargo argv.',
      );
    }

    const repoRoot = resolve(opts.repoRoot ?? DEFAULT_REPO_ROOT);
    const manifestPath = join(repoRoot, 'native', 'Cargo.toml');
    const cargoLockPath = join(repoRoot, 'native', 'Cargo.lock');
    readRegularFile(manifestPath, { nonEmpty: true });
    const cargoLockShaBefore = sha256Hex(readRegularFile(cargoLockPath, { nonEmpty: true }));
    if (opts.cargoLockPath) {
      const explicitLockSha = sha256Hex(readRegularFile(resolve(opts.cargoLockPath), { nonEmpty: true }));
      if (explicitLockSha !== cargoLockShaBefore) {
        throw new Error(`--cargo-lock SHA-256 ${explicitLockSha} disagrees with ${cargoLockPath} (${cargoLockShaBefore}).`);
      }
    }

    const gitBefore = readGitState(repoRoot);
    const rustcVersion = execText('rustc', [...toolchainArgs, '--version'], repoRoot);
    const hostBaseline = assertNonEmptyKnownString(
      opts.hostBaseline ?? `${process.platform}-${process.arch}`,
      'hostBaseline',
    );

    const releaseDir = join(targetDir, 'release');
    const slotDefs = [
      { key: 'clec', path: join(releaseDir, targetMeta.binaryName), expectedKind: 'clec', binaryName: targetMeta.binaryName },
    ];
    if (opts.requireMaintainer !== false) {
      slotDefs.push(
        {
          key: 'clecPublish',
          path: join(releaseDir, targetMeta.maintainerBinaries[0]),
          expectedKind: 'clec-publish',
          binaryName: targetMeta.maintainerBinaries[0],
        },
        {
          key: 'clecValidate',
          path: join(releaseDir, targetMeta.maintainerBinaries[1]),
          expectedKind: 'clec-validate',
          binaryName: targetMeta.maintainerBinaries[1],
        },
      );
    }

    for (const slot of slotDefs) {
      rmSync(slot.path, { force: true });
    }

    const cargoArgs = [
      ...toolchainArgs,
      'build',
      '--manifest-path',
      manifestPath,
      '--locked',
      '--release',
      '--bins',
      '-j',
      '2',
    ];
    execFileSync('cargo', cargoArgs, {
      cwd: repoRoot,
      env: { ...process.env, CARGO_TARGET_DIR: targetDir },
      stdio: 'inherit',
    });

    const gitAfter = readGitState(repoRoot);
    if (gitAfter.commit !== gitBefore.commit) {
      throw new Error(
        `Source commit changed during controlled build (before=${gitBefore.commit}, after=${gitAfter.commit}).`,
      );
    }
    if (gitAfter.statusRaw !== gitBefore.statusRaw) {
      throw new Error('Source working tree changed during controlled build.');
    }
    const cargoLockShaAfter = sha256Hex(readRegularFile(cargoLockPath, { nonEmpty: true }));
    if (cargoLockShaAfter !== cargoLockShaBefore) {
      throw new Error('Cargo.lock changed during controlled build.');
    }

    const { artifacts, referenceIdentity } = inspectArtifacts(
      slotDefs,
      targetMeta,
      rustcVersion,
      cargoLockShaAfter,
    );

    const receipt = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      receiptKind: CONTROLLED_BUILD_RECEIPT_KIND,
      trustModel: 'unsigned-local-controlled-build-receipt',
      packageName: PACKAGE_NAME,
      packageVersion: PACKAGE_VERSION,
      tuple: targetMeta.tuple,
      rustTarget: targetMeta.rustTarget,
      provenance: {
        source: {
          status: ESTABLISHED_SOURCE,
          sourceCommit: gitAfter.commit,
          sourceDirty: gitAfter.dirty,
        },
        buildInvocation: {
          status: ESTABLISHED_BUILD,
          executable: 'cargo',
          argv: cargoArgs,
          command: ['cargo', ...cargoArgs].join(' '),
          hostBaseline,
        },
      },
      verifiedEmbeddedMetadata: {
        cargoLockSha256: referenceIdentity.cargoLockSha256,
        rustcVersion: referenceIdentity.rustcVersion,
        profile: referenceIdentity.profile,
        features: referenceIdentity.features,
        testHooksIncluded: referenceIdentity.testHooks,
      },
      artifacts,
    };

    return writeReceiptIfRequested(opts.out, receipt);
  }

  if (!targetDir && !opts.clec) {
    throw new Error('Inspected prebuilt receipt requires --target-dir or --clec.');
  }

  const releaseDir = targetDir ? join(targetDir, 'release') : null;
  const clecPath = opts.clec ? resolve(opts.clec) : join(releaseDir, targetMeta.binaryName);
  const pubPath = opts.clecPublish
    ? resolve(opts.clecPublish)
    : releaseDir
      ? join(releaseDir, targetMeta.maintainerBinaries[0])
      : null;
  const valPath = opts.clecValidate
    ? resolve(opts.clecValidate)
    : releaseDir
      ? join(releaseDir, targetMeta.maintainerBinaries[1])
      : null;

  const slotDefs = [
    { key: 'clec', path: clecPath, expectedKind: 'clec', binaryName: targetMeta.binaryName },
  ];
  const includeMaintainer =
    opts.requireMaintainer === true || Boolean(opts.clecPublish || opts.clecValidate || (pubPath && existsSync(pubPath)));
  if (includeMaintainer) {
    if (!pubPath || !valPath) {
      throw new Error(`Maintainer binaries required for tuple '${targetMeta.tuple}'.`);
    }
    slotDefs.push(
      {
        key: 'clecPublish',
        path: pubPath,
        expectedKind: 'clec-publish',
        binaryName: targetMeta.maintainerBinaries[0],
      },
      {
        key: 'clecValidate',
        path: valPath,
        expectedKind: 'clec-validate',
        binaryName: targetMeta.maintainerBinaries[1],
      },
    );
  }

  const expectedRustc = opts.toolchain
    ? execText('rustc', [...toolchainArgs, '--version'], process.cwd())
    : null;
  const expectedCargoLockSha = opts.cargoLockPath
    ? sha256Hex(readRegularFile(resolve(opts.cargoLockPath), { nonEmpty: true }))
    : null;

  const { artifacts, referenceIdentity } = inspectArtifacts(
    slotDefs,
    targetMeta,
    expectedRustc,
    expectedCargoLockSha,
  );

  let observedGit = null;
  if (opts.repoRoot !== undefined && opts.repoRoot !== null) {
    const gitState = readGitState(resolve(opts.repoRoot));
    observedGit = { commit: gitState.commit, dirty: gitState.dirty };
  } else if (opts.repoRoot === undefined && existsSync(join(DEFAULT_REPO_ROOT, '.git'))) {
    const gitState = readGitState(DEFAULT_REPO_ROOT);
    observedGit = { commit: gitState.commit, dirty: gitState.dirty };
  }

  const declaredBuildCommand =
    opts.buildCommand !== undefined && opts.buildCommand !== null
      ? assertNonEmptyKnownString(opts.buildCommand, 'declaredBuildCommand')
      : null;
  const declaredHostBaseline =
    opts.hostBaseline !== undefined && opts.hostBaseline !== null
      ? assertNonEmptyKnownString(opts.hostBaseline, 'declaredHostBaseline')
      : null;

  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    receiptKind: INSPECTED_PREBUILT_RECEIPT_KIND,
    trustModel: 'unsigned-inspected-prebuilt-receipt',
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    tuple: targetMeta.tuple,
    rustTarget: targetMeta.rustTarget,
    provenance: {
      source: {
        status: NOT_VERIFIED_UNKNOWN,
        reason: 'inspected_prebuilt_without_controlled_build',
      },
      buildInvocation: {
        status: NOT_VERIFIED_UNKNOWN,
        reason: 'inspected_prebuilt_without_controlled_build',
      },
    },
    captureObservation: {
      observedGit,
      declaredBuildCommand,
      declaredHostBaseline,
    },
    verifiedEmbeddedMetadata: {
      cargoLockSha256: referenceIdentity.cargoLockSha256,
      rustcVersion: referenceIdentity.rustcVersion,
      profile: referenceIdentity.profile,
      features: referenceIdentity.features,
      testHooksIncluded: referenceIdentity.testHooks,
    },
    artifacts,
  };

  return writeReceiptIfRequested(opts.out, receipt);
}

const isEntrypoint = (() => {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();

if (isEntrypoint) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const receipt = captureBuildReceipt(opts);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`build-receipt failed: ${err.message}\n`);
    process.exit(1);
  }
}
