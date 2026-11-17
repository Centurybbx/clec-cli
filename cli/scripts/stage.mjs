import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeterministicTarGz, createDeterministicZip } from './archive.mjs';
import {
  BIN_TARGET_REL,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  TARGET_MATRIX,
  findTargetByTuple,
} from './targets.mjs';

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function readRegularFile(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Expected regular non-symlink file: ${path}`);
  }
  return readFileSync(path);
}

function parseArgs(argv) {
  const opts = {
    input: null,
    output: null,
    allowPartial: false,
    sourceCommit: 'unknown',
    rustcVersion: 'unknown',
    cargoLockPath: null,
    buildCommand: 'unknown',
    hostBaseline: `${process.platform}-${process.arch}`,
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
  const skillBytes = readRegularFile(join(root, 'skills/clec/SKILL.md'));
  const noticesBytes = readRegularFile(join(root, 'NOTICES.md'));
  const readmeBytes = readRegularFile(join(root, 'README.md'));

  const targetsInventory = {};
  const npmPayloadEntries = [];
  const artifacts = [];
  const missingTuples = [];

  for (const meta of TARGET_MATRIX) {
    const supplied = inputSpec.targets[meta.tuple];
    if (!supplied) {
      missingTuples.push(meta.tuple);
      targetsInventory[meta.tuple] = {
        status: 'missing',
        platform: meta.platform,
        arch: meta.arch,
        rustTarget: meta.rustTarget,
        binaryName: meta.binaryName,
        reason: 'no prebuilt artifact supplied',
      };
      continue;
    }

    if (!supplied.clec) {
      throw new Error(`Target ${meta.tuple} must specify \`clec\` binary path.`);
    }
    const clecPath = resolve(supplied.clec);
    if (clecPath.includes('clec_test_fixture')) {
      throw new Error(`Refusing test-hooks fixture binary in release staging: ${clecPath}`);
    }
    const clecBytes = readRegularFile(clecPath);
    const clecSha = sha256Hex(clecBytes);
    const payloadRel = `payloads/${meta.tuple}/${meta.binaryName}`;

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
      executionEvidence: supplied.executionEvidence ?? 'unverified',
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

    if (supplied.clecPublish || supplied.clecValidate) {
      if (!supplied.clecPublish || !supplied.clecValidate) {
        throw new Error(
          `Target ${meta.tuple} maintainer archive requires both \`clecPublish\` and \`clecValidate\`.`,
        );
      }
      const pubBytes = readRegularFile(resolve(supplied.clecPublish));
      const valBytes = readRegularFile(resolve(supplied.clecValidate));
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

  const complete = missingTuples.length === 0;
  if (!complete && !opts.allowPartial) {
    throw new Error(
      `Refusing incomplete production staging; missing target tuples: ${missingTuples.join(', ')}. Pass --allow-partial for local partial staging.`,
    );
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

  const cargoLockSha256 = opts.cargoLockPath
    ? sha256Hex(readRegularFile(resolve(opts.cargoLockPath)))
    : null;
  const provenance = {
    schemaVersion: 1,
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    complete,
    publishable: false,
    sourceCommit: opts.sourceCommit,
    cargoLockSha256,
    rustcVersion: opts.rustcVersion,
    features: [],
    testHooksIncluded: false,
    buildCommand: opts.buildCommand,
    hostBaseline: opts.hostBaseline,
    licenseStatus: 'unassigned_pending_maintainer_confirmation',
    repositoryNote:
      'Recorded metadata Centurybbx/clec-cli returned 404 and root git has no remotes; no public release URL assumed.',
    targets: targetsInventory,
  };
  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  writeFileSync(join(outputDir, 'provenance.json'), provenanceBytes);

  const npmEntries = [
    { path: 'package/package.json', data: pkgJsonBytes, executable: false },
    { path: `package/${BIN_TARGET_REL}`, data: placeholderBytes, executable: false },
    { path: 'package/scripts/install.mjs', data: installScriptBytes, executable: false },
    { path: 'package/scripts/targets.mjs', data: targetsScriptBytes, executable: false },
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

const isEntrypoint =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

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
