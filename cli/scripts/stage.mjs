import { lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeterministicTarGz, createDeterministicZip } from './archive.mjs';
import {
  admitTargetArtifacts,
  assertNonEmptyKnownString,
  readRegularFile,
  sha256Hex,
} from './artifact-admission.mjs';
import {
  BIN_TARGET_REL,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  TARGET_MATRIX,
  findTargetByTuple,
} from './targets.mjs';

function parseArgs(argv) {
  const opts = {
    input: null,
    output: null,
    allowPartial: false,
    sourceCommit: null,
    rustcVersion: null,
    cargoLockPath: null,
    buildCommand: null,
    hostBaseline: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      opts.input = argv[++i];
    } else if (arg === '--output') {
      opts.output = argv[++i];
    } else if (arg === '--allow-partial') {
      opts.allowPartial = true;
    } else if (arg === '--source-commit') {
      opts.sourceCommit = argv[++i];
    } else if (arg === '--rustc-version') {
      opts.rustcVersion = argv[++i];
    } else if (arg === '--cargo-lock') {
      opts.cargoLockPath = argv[++i];
    } else if (arg === '--build-command') {
      opts.buildCommand = argv[++i];
    } else if (arg === '--host-baseline') {
      opts.hostBaseline = argv[++i];
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!opts.input || !opts.output) {
    throw new Error(
      'Usage: stage.mjs --input <inputs.json> --output <new-dir> [--allow-partial] [--source-commit SHA] [--rustc-version VER] [--cargo-lock PATH] [--build-command CMD] [--host-baseline STR]',
    );
  }
  return opts;
}

function ensureEmptyOrMissingDir(outputDir) {
  try {
    const st = lstatSync(outputDir);
    if (!st.isDirectory()) {
      throw new Error(`Output path exists and is not a directory: ${outputDir}`);
    }
    const existing = readdirSync(outputDir);
    if (existing.length > 0) {
      throw new Error(`Output directory must be empty: ${outputDir}`);
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      mkdirSync(outputDir, { recursive: true });
      return;
    }
    throw err;
  }
}

function uniformOrPerTarget(values) {
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : 'per-target';
}

function assertOptionalCliMatches(cliValue, receiptValues, fieldName) {
  if (cliValue === undefined || cliValue === null) {
    return;
  }
  const checked = assertNonEmptyKnownString(cliValue, fieldName);
  for (const rv of receiptValues) {
    if (rv !== checked) {
      throw new Error(
        `CLI --${fieldName} '${checked}' contradicts bound build receipt value '${rv}'.`,
      );
    }
  }
}

export function stageRelease(opts, cliRoot) {
  const root = resolve(cliRoot);
  const outputDir = resolve(opts.output);
  ensureEmptyOrMissingDir(outputDir);

  const inputSpec = JSON.parse(readRegularFile(resolve(opts.input)).toString('utf8'));
  if (typeof inputSpec !== 'object' || inputSpec === null || typeof inputSpec.targets !== 'object') {
    throw new Error('Input spec must contain a `targets` object keyed by target tuple.');
  }
  for (const key of Object.keys(inputSpec.targets)) {
    if (!findTargetByTuple(key)) {
      throw new Error(`Unknown target tuple in input spec: ${key}`);
    }
  }

  const pkgJsonBytes = readRegularFile(join(root, 'package.json'));
  const pkgJson = JSON.parse(pkgJsonBytes.toString('utf8'));
  if (pkgJson.name !== PACKAGE_NAME || pkgJson.version !== PACKAGE_VERSION) {
    throw new Error(
      `Expected ${PACKAGE_NAME}@${PACKAGE_VERSION} in cli/package.json, found ${pkgJson.name}@${pkgJson.version}.`,
    );
  }
  const placeholderBytes = readRegularFile(join(root, BIN_TARGET_REL));
  const installScriptBytes = readRegularFile(join(root, 'scripts/install.mjs'));
  const targetsScriptBytes = readRegularFile(join(root, 'scripts/targets.mjs'));
  const admissionScriptBytes = readRegularFile(join(root, 'scripts/artifact-admission.mjs'));
  const skillBytes = readRegularFile(join(root, 'skills/clec/SKILL.md'));
  const noticesBytes = readRegularFile(join(root, 'NOTICES.md'));
  const readmeBytes = readRegularFile(join(root, 'README.md'));

  const expectedCargoLockSha256 = opts.cargoLockPath
    ? sha256Hex(readRegularFile(resolve(opts.cargoLockPath), { nonEmpty: true }))
    : null;

  const missingTuples = [];
  const admittedByTuple = new Map();

  for (const meta of TARGET_MATRIX) {
    const supplied = inputSpec.targets[meta.tuple];
    if (!supplied) {
      missingTuples.push(meta.tuple);
      continue;
    }
    const admitted = admitTargetArtifacts(meta, supplied, {
      packageVersion: PACKAGE_VERSION,
      expectedCargoLockSha256,
      allowPartial: Boolean(opts.allowPartial),
    });
    admittedByTuple.set(meta.tuple, admitted);
  }

  const complete = missingTuples.length === 0;
  if (!complete && !opts.allowPartial) {
    throw new Error(
      `Refusing incomplete production staging; missing target tuples: ${missingTuples.join(', ')}. Pass --allow-partial for local partial staging.`,
    );
  }
  if (admittedByTuple.size === 0) {
    throw new Error('At least one admitted target tuple is required to stage.');
  }

  const admittedReceipts = [...admittedByTuple.values()].map((item) => item.receipt);
  const sourceCommits = [...new Set(admittedReceipts.map((r) => r.sourceCommit))];
  if (sourceCommits.length !== 1) {
    throw new Error(`Admitted build receipts disagree on sourceCommit: ${sourceCommits.join(', ')}.`);
  }
  const cargoLocks = [...new Set(admittedReceipts.map((r) => r.cargoLockSha256))];
  if (cargoLocks.length !== 1) {
    throw new Error(`Admitted build receipts disagree on cargoLockSha256: ${cargoLocks.join(', ')}.`);
  }

  assertOptionalCliMatches(opts.sourceCommit, sourceCommits, 'source-commit');
  assertOptionalCliMatches(
    opts.rustcVersion,
    admittedReceipts.map((r) => r.rustcVersion),
    'rustc-version',
  );
  assertOptionalCliMatches(
    opts.buildCommand,
    admittedReceipts.map((r) => r.buildCommand),
    'build-command',
  );
  assertOptionalCliMatches(
    opts.hostBaseline,
    admittedReceipts.map((r) => r.hostBaseline),
    'host-baseline',
  );

  const targetsInventory = {};
  const provenanceTargets = {};
  const npmPayloadEntries = [];
  const artifacts = [];

  for (const meta of TARGET_MATRIX) {
    const admitted = admittedByTuple.get(meta.tuple);
    if (!admitted) {
      const missingEntry = {
        status: 'missing',
        platform: meta.platform,
        arch: meta.arch,
        rustTarget: meta.rustTarget,
        binaryName: meta.binaryName,
        reason: 'no prebuilt artifact supplied',
      };
      targetsInventory[meta.tuple] = missingEntry;
      provenanceTargets[meta.tuple] = missingEntry;
      continue;
    }

    const payloadRel = `payloads/${meta.tuple}/${meta.binaryName}`;
    const clecSha = admitted.clec.sha256;
    const clecBytes = admitted.clec.bytes;

    targetsInventory[meta.tuple] = {
      status: 'present',
      platform: meta.platform,
      arch: meta.arch,
      rustTarget: meta.rustTarget,
      binaryName: meta.binaryName,
      libc: meta.libc,
      payloadPath: payloadRel,
      bytes: clecBytes.length,
      sha256: clecSha,
      structuralIdentity: admitted.structuralIdentity,
      executionEvidence: admitted.executionEvidence,
    };

    provenanceTargets[meta.tuple] = {
      ...targetsInventory[meta.tuple],
      buildReceipt: {
        receiptKind: admitted.receipt.receiptKind,
        trustModel: admitted.receipt.trustModel,
        sourceCommit: admitted.receipt.sourceCommit,
        sourceDirty: admitted.receipt.sourceDirty,
        cargoLockSha256: admitted.receipt.cargoLockSha256,
        rustcVersion: admitted.receipt.rustcVersion,
        buildCommand: admitted.receipt.buildCommand,
        hostBaseline: admitted.receipt.hostBaseline,
        artifacts: admitted.receipt.artifacts,
      },
    };

    npmPayloadEntries.push({
      path: `package/${payloadRel}`,
      data: clecBytes,
      executable: true,
    });

    const consumerRoot = `clec-v${PACKAGE_VERSION}-${meta.tuple}`;
    const consumerChecksums = `${clecSha}  ${meta.binaryName}\n${sha256Hex(skillBytes)}  skills/clec/SKILL.md\n${sha256Hex(noticesBytes)}  NOTICES.md\n${sha256Hex(readmeBytes)}  README.md\n`;
    const consumerEntries = [
      { path: `${consumerRoot}/${meta.binaryName}`, data: clecBytes, executable: true },
      { path: `${consumerRoot}/skills/clec/SKILL.md`, data: skillBytes, executable: false },
      { path: `${consumerRoot}/NOTICES.md`, data: noticesBytes, executable: false },
      { path: `${consumerRoot}/README.md`, data: readmeBytes, executable: false },
      {
        path: `${consumerRoot}/CHECKSUMS.sha256`,
        data: Buffer.from(consumerChecksums, 'utf8'),
        executable: false,
      },
    ];
    const consumerArchiveName = `${consumerRoot}.${meta.archiveFormat}`;
    const consumerArchiveBytes =
      meta.archiveFormat === 'zip'
        ? createDeterministicZip(consumerEntries)
        : createDeterministicTarGz(consumerEntries);
    writeFileSync(join(outputDir, consumerArchiveName), consumerArchiveBytes);
    artifacts.push({
      kind: 'consumer-archive',
      tuple: meta.tuple,
      filename: consumerArchiveName,
      bytes: consumerArchiveBytes.length,
      sha256: sha256Hex(consumerArchiveBytes),
    });

    if (admitted.maintainer) {
      const pubBytes = admitted.maintainer.clecPublish.bytes;
      const valBytes = admitted.maintainer.clecValidate.bytes;
      const [pubName, valName] = meta.maintainerBinaries;
      const maintRoot = `clec-maintainer-v${PACKAGE_VERSION}-${meta.tuple}`;
      const maintChecksums = `${sha256Hex(pubBytes)}  ${pubName}\n${sha256Hex(valBytes)}  ${valName}\n${sha256Hex(noticesBytes)}  NOTICES.md\n`;
      const maintEntries = [
        { path: `${maintRoot}/${pubName}`, data: pubBytes, executable: true },
        { path: `${maintRoot}/${valName}`, data: valBytes, executable: true },
        { path: `${maintRoot}/NOTICES.md`, data: noticesBytes, executable: false },
        {
          path: `${maintRoot}/CHECKSUMS.sha256`,
          data: Buffer.from(maintChecksums, 'utf8'),
          executable: false,
        },
      ];
      const maintArchiveName = `${maintRoot}.${meta.archiveFormat}`;
      const maintArchiveBytes =
        meta.archiveFormat === 'zip'
          ? createDeterministicZip(maintEntries)
          : createDeterministicTarGz(maintEntries);
      writeFileSync(join(outputDir, maintArchiveName), maintArchiveBytes);
      artifacts.push({
        kind: 'maintainer-archive',
        tuple: meta.tuple,
        filename: maintArchiveName,
        bytes: maintArchiveBytes.length,
        sha256: sha256Hex(maintArchiveBytes),
      });
    }
  }

  const inventory = {
    schemaVersion: 1,
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    complete,
    publishable: false,
    targets: targetsInventory,
  };
  const inventoryBytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  writeFileSync(join(outputDir, 'inventory.json'), inventoryBytes);

  const provenance = {
    schemaVersion: 1,
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    complete,
    publishable: false,
    trustBoundary:
      'Unsigned local build receipts bind payload SHA-256 hashes to observed compiler, Cargo.lock, and embedded compile metadata; they do not authenticate a remote publisher or certify execution on unexecuted target OSes.',
    sourceCommit: sourceCommits[0],
    sourceDirty: admittedReceipts.some((r) => r.sourceDirty),
    cargoLockSha256: cargoLocks[0],
    rustcVersion: uniformOrPerTarget(admittedReceipts.map((r) => r.rustcVersion)),
    features: [],
    testHooksIncluded: false,
    buildCommand: uniformOrPerTarget(admittedReceipts.map((r) => r.buildCommand)),
    hostBaseline: uniformOrPerTarget(admittedReceipts.map((r) => r.hostBaseline)),
    licenseStatus: 'unassigned_pending_maintainer_confirmation',
    repositoryNote:
      'Recorded metadata Centurybbx/clec-cli returned 404 and root git has no remotes; no public release URL assumed.',
    targets: provenanceTargets,
  };
  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  writeFileSync(join(outputDir, 'provenance.json'), provenanceBytes);

  const npmEntries = [
    { path: 'package/package.json', data: pkgJsonBytes, executable: false },
    { path: `package/${BIN_TARGET_REL}`, data: placeholderBytes, executable: false },
    { path: 'package/scripts/install.mjs', data: installScriptBytes, executable: false },
    { path: 'package/scripts/targets.mjs', data: targetsScriptBytes, executable: false },
    { path: 'package/scripts/artifact-admission.mjs', data: admissionScriptBytes, executable: false },
    { path: 'package/skills/clec/SKILL.md', data: skillBytes, executable: false },
    { path: 'package/NOTICES.md', data: noticesBytes, executable: false },
    { path: 'package/README.md', data: readmeBytes, executable: false },
    { path: 'package/inventory.json', data: inventoryBytes, executable: false },
    ...npmPayloadEntries,
  ];
  const npmTarballName = `clec-cli-${PACKAGE_VERSION}.tgz`;
  const npmTarballBytes = createDeterministicTarGz(npmEntries);
  writeFileSync(join(outputDir, npmTarballName), npmTarballBytes);
  artifacts.push({
    kind: 'npm-tarball',
    tuple: complete ? 'all' : 'partial',
    filename: npmTarballName,
    bytes: npmTarballBytes.length,
    sha256: sha256Hex(npmTarballBytes),
  });

  const sumTargets = [
    ...artifacts.map((a) => ({ filename: a.filename, sha256: a.sha256 })),
    { filename: 'inventory.json', sha256: sha256Hex(inventoryBytes) },
    { filename: 'provenance.json', sha256: sha256Hex(provenanceBytes) },
  ].sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  const sha256sums = `${sumTargets.map((item) => `${item.sha256}  ${item.filename}`).join('\n')}\n`;
  writeFileSync(join(outputDir, 'SHA256SUMS'), sha256sums, 'utf8');

  return {
    outputDir,
    complete,
    publishable: false,
    missingTuples,
    artifacts,
    sha256sumsSha256: sha256Hex(Buffer.from(sha256sums, 'utf8')),
  };
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
  const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = stageRelease(opts, cliRoot);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`stage failed: ${err.message}\n`);
    process.exit(1);
  }
}
