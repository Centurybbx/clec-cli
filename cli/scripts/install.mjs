import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  } catch {
    // Best-effort cleanup so a failed repair never leaves an unverified binary.
  }
}

function assertSafeChildPath(root, relPath) {
  if (
    typeof relPath !== 'string' ||
    relPath.length === 0 ||
    relPath.startsWith('/') ||
    relPath.includes('\\') ||
    relPath.includes('..') ||
    !relPath.startsWith('payloads/')
  ) {
    throw new Error(`Unsafe payloadPath in inventory.json: ${String(relPath)}`);
  }
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, relPath);
  const rel = relative(resolvedRoot, target);
  if (rel.startsWith('..') || rel === '') {
    throw new Error(`Payload escapes package root: ${relPath}`);
  }
  return target;
}

export function installFromRoot(pkgRoot, options = {}) {
  const root = resolve(pkgRoot);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const destBin = join(root, BIN_TARGET_REL);

  const fail = (message) => {
    restorePlaceholder(destBin);
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
  if (
    inventory.schemaVersion !== 1 ||
    inventory.packageName !== PACKAGE_NAME ||
    inventory.packageVersion !== PACKAGE_VERSION ||
    typeof inventory.targets !== 'object' ||
    inventory.targets === null
  ) {
    fail('Invalid inventory.json header or version mismatch.');
  }

  const targetMeta = findTargetByPlatformArch(platform, arch);
  if (!targetMeta) {
    fail(
      `Unsupported platform/architecture '${platform}-${arch}'. Supported tuples: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64.`,
    );
  }

  const entry = inventory.targets[targetMeta.tuple];
  if (!entry || entry.status !== 'present') {
    const reason = entry && entry.reason ? ` (${entry.reason})` : '';
    fail(
      `Bundled binary for '${targetMeta.tuple}' (${targetMeta.rustTarget}) is not included in this package${reason}. Download the direct release archive for your target instead.`,
    );
  }

  if (
    typeof entry.bytes !== 'number' ||
    !Number.isInteger(entry.bytes) ||
    entry.bytes <= 0 ||
    typeof entry.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(entry.sha256)
  ) {
    fail(`Invalid inventory metadata for tuple '${targetMeta.tuple}'.`);
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
  const actualSha = createHash('sha256').update(bytes).digest('hex');
  if (actualSha !== entry.sha256) {
    fail(
      `Payload SHA-256 mismatch for '${targetMeta.tuple}': expected ${entry.sha256}, got ${actualSha}.`,
    );
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
      // Ignore temp cleanup errors.
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

const isEntrypoint =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

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
