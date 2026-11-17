import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertExecutableMatchesTarget,
  assertReleaseBuildIdentity,
  assertSafeChildPath,
  extractEmbeddedBuildIdentity,
  sha256Hex,
  validateInventoryHeader,
  validateInventoryTargetEntry,
} from './artifact-admission.mjs';
import {
  BIN_TARGET_REL,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  findTargetByPlatformArch,
} from './targets.mjs';

const PLACEHOLDER_BYTES = Buffer.from(
  '\x00\x00\x00\x00CLEC_UNINSTALLED_PLACEHOLDER: npm lifecycle scripts did not run; reinstall without --ignore-scripts or download a direct release archive.\n',
  'utf8',
);

function restorePlaceholder(destBin) {
  try {
    mkdirSync(dirname(destBin), { recursive: true });
    writeFileSync(destBin, PLACEHOLDER_BYTES, { mode: 0o644 });
    if (process.platform !== 'win32') {
      chmodSync(destBin, 0o644);
    }
    return null;
  } catch (err) {
    return err;
  }
}

export function installFromRoot(pkgRoot, options = {}) {
  const root = resolve(pkgRoot);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const destBin = join(root, BIN_TARGET_REL);

  const fail = (message) => {
    const restoreErr = restorePlaceholder(destBin);
    if (restoreErr) {
      throw new Error(`${message} (placeholder restoration failed: ${restoreErr.message})`);
    }
    throw new Error(message);
  };

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch (err) {
    fail(`Cannot read package.json in ${root}: ${err.message}`);
  }
  if (pkg.name !== PACKAGE_NAME || pkg.version !== PACKAGE_VERSION) {
    fail(
      `Package identity mismatch: expected ${PACKAGE_NAME}@${PACKAGE_VERSION}, got ${pkg.name}@${pkg.version}.`,
    );
  }

  let inventory;
  try {
    inventory = JSON.parse(readFileSync(join(root, 'inventory.json'), 'utf8'));
  } catch (err) {
    fail(
      `Missing or invalid inventory.json (${err.message}). Install from a staged tarball or use a direct release archive.`,
    );
  }
  try {
    validateInventoryHeader(inventory);
  } catch (err) {
    fail(err.message);
  }

  const targetMeta = findTargetByPlatformArch(platform, arch);
  if (!targetMeta) {
    fail(
      `Unsupported platform/architecture '${platform}-${arch}'. Supported tuples: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64.`,
    );
  }

  const entry = inventory.targets[targetMeta.tuple];
  try {
    validateInventoryTargetEntry(entry, targetMeta);
  } catch (err) {
    fail(err.message);
  }

  let payloadPath;
  try {
    payloadPath = assertSafeChildPath(root, entry.payloadPath);
  } catch (err) {
    fail(err.message);
  }

  let payloadStat;
  try {
    payloadStat = lstatSync(payloadPath);
  } catch (err) {
    fail(`Missing payload file for '${targetMeta.tuple}' at ${entry.payloadPath}: ${err.message}`);
  }
  if (payloadStat.isSymbolicLink() || !payloadStat.isFile()) {
    fail(`Payload for '${targetMeta.tuple}' must be a regular file, not a symlink.`);
  }

  const bytes = readFileSync(payloadPath);
  if (bytes.length !== entry.bytes) {
    fail(
      `Payload byte length mismatch for '${targetMeta.tuple}': expected ${entry.bytes}, got ${bytes.length}.`,
    );
  }
  const actualSha = sha256Hex(bytes);
  if (actualSha !== entry.sha256) {
    fail(
      `Payload SHA-256 mismatch for '${targetMeta.tuple}': expected ${entry.sha256}, got ${actualSha}.`,
    );
  }

  try {
    assertExecutableMatchesTarget(bytes, targetMeta);
    const embedded = extractEmbeddedBuildIdentity(bytes);
    assertReleaseBuildIdentity(embedded, 'clec', PACKAGE_VERSION, targetMeta.rustTarget);
  } catch (err) {
    fail(err.message);
  }

  mkdirSync(dirname(destBin), { recursive: true });
  const tmpBin = join(dirname(destBin), `.clec.exe.tmp.${process.pid}`);
  try {
    rmSync(tmpBin, { force: true });
    writeFileSync(tmpBin, bytes);
    if (platform !== 'win32') {
      chmodSync(tmpBin, 0o755);
    }
    renameSync(tmpBin, destBin);
  } catch (err) {
    try {
      rmSync(tmpBin, { force: true });
    } catch {
    }
    fail(`Failed to install native binary to ${destBin}: ${err.message}`);
  }

  return {
    tuple: targetMeta.tuple,
    rustTarget: targetMeta.rustTarget,
    bytes: bytes.length,
    sha256: actualSha,
    destination: destBin,
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
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const receipt = installFromRoot(pkgRoot);
    process.stdout.write(
      `Installed ${PACKAGE_NAME}@${PACKAGE_VERSION} (${receipt.tuple}, ${receipt.bytes} bytes, sha256:${receipt.sha256})\n`,
    );
  } catch (err) {
    process.stderr.write(`clec install failed: ${err.message}\n`);
    process.exit(1);
  }
}
