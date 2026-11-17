import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertExecutableMatchesTarget,
  assertNonEmptyKnownString,
  extractEmbeddedBuildIdentity,
  readRegularFile,
  sha256Hex,
} from './artifact-admission.mjs';
import { PACKAGE_NAME, PACKAGE_VERSION, findTargetByTuple } from './targets.mjs';

function parseArgs(argv) {
  const opts = {
    tuple: null,
    targetDir: null,
    out: null,
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    runBuild: false,
    toolchain: null,
    buildCommand: null,
    hostBaseline: `${process.platform}-${process.arch}`,
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
      'Usage: build-receipt.mjs --tuple <tuple> (--target-dir <dir> | --clec <path>) --out <receipt.json> [--run-build] [--toolchain <ver>] [--build-command <cmd>] [--host-baseline <str>] [--repo-root <dir>]',
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

export function captureBuildReceipt(opts) {
  const targetMeta = findTargetByTuple(opts.tuple);
  if (!targetMeta) {
    throw new Error(`Unknown target tuple: ${opts.tuple}`);
  }
  const repoRoot = resolve(opts.repoRoot ?? join(dirname(fileURLToPath(import.meta.url)), '../..'));
  const manifestPath = join(repoRoot, 'native', 'Cargo.toml');
  const cargoLockPath = join(repoRoot, 'native', 'Cargo.lock');
  const cargoLockSha256 = sha256Hex(readRegularFile(cargoLockPath, { nonEmpty: true }));

  const sourceCommit = execText('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], repoRoot);
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error(`Unexpected git HEAD SHA: ${sourceCommit}`);
  }
  const gitStatus = execText('git', ['-C', repoRoot, 'status', '--porcelain'], repoRoot);
  const sourceDirty = gitStatus.length > 0;

  const toolchainArgs = opts.toolchain ? [`+${opts.toolchain}`] : [];
  const rustcVersion = execText('rustc', [...toolchainArgs, '--version'], repoRoot);

  let buildCommand = opts.buildCommand;
  const targetDir = opts.targetDir ? resolve(opts.targetDir) : null;
  if (opts.runBuild) {
    if (!targetDir) {
      throw new Error('--run-build requires --target-dir.');
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
    buildCommand = `cargo ${cargoArgs.join(' ')}`;
  }
  const verifiedBuildCommand = assertNonEmptyKnownString(buildCommand, 'buildCommand');
  const hostBaseline = assertNonEmptyKnownString(opts.hostBaseline, 'hostBaseline');

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
    opts.requireMaintainer || Boolean(opts.clecPublish || opts.clecValidate || (pubPath && existsSync(pubPath)));
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

  const artifacts = {};
  let referenceIdentity = null;

  for (const slot of slotDefs) {
    const bytes = readRegularFile(slot.path, { nonEmpty: true });
    assertExecutableMatchesTarget(bytes, targetMeta);
    const embedded = extractEmbeddedBuildIdentity(bytes);
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
    if (embedded.cargoLockSha256 !== cargoLockSha256) {
      throw new Error(
        `Artifact ${slot.path} embedded cargoLockSha256 '${embedded.cargoLockSha256}' != '${cargoLockSha256}'.`,
      );
    }
    if (embedded.rustcVersion !== rustcVersion) {
      throw new Error(
        `Artifact ${slot.path} embedded rustcVersion '${embedded.rustcVersion}' != '${rustcVersion}'.`,
      );
    }
    if (referenceIdentity === null) {
      referenceIdentity = embedded;
    } else if (
      referenceIdentity.profile !== embedded.profile ||
      referenceIdentity.testHooks !== embedded.testHooks ||
      JSON.stringify(referenceIdentity.features) !== JSON.stringify(embedded.features)
    ) {
      throw new Error(`Artifact ${slot.path} profile/features disagree with clec binary.`);
    }

    artifacts[slot.key] = {
      kind: embedded.artifactKind,
      binaryName: slot.binaryName,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      embeddedMetadata: embedded,
    };
  }

  const receipt = {
    schemaVersion: 1,
    receiptKind: 'clec-build-receipt',
    trustModel: 'unsigned-local-build-receipt',
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    tuple: targetMeta.tuple,
    rustTarget: targetMeta.rustTarget,
    sourceCommit,
    sourceDirty,
    cargoLockSha256,
    rustcVersion,
    profile: referenceIdentity.profile,
    features: referenceIdentity.features,
    testHooksIncluded: referenceIdentity.testHooks,
    buildCommand: verifiedBuildCommand,
    hostBaseline,
    artifacts,
  };

  if (opts.out) {
    const outPath = resolve(opts.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  }
  return receipt;
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
