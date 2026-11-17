import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { NATIVE_CRATE_NAME, PACKAGE_NAME, PACKAGE_VERSION } from './targets.mjs';

export const IDENTITY_PREFIX = Buffer.from('\0CLEC_BUILD_IDENTITY_V1\0', 'utf8');
export const IDENTITY_SUFFIX = Buffer.from('\0END_CLEC_BUILD_IDENTITY_V1\0', 'utf8');

const VALID_ARTIFACT_KINDS = new Set(['clec', 'clec-publish', 'clec-validate', 'clec_test_fixture']);
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;
const MH_EXECUTE = 0x2;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

const ELF_CLASS_64 = 2;
const ELF_DATA_LSB = 1;
const ELF_VERSION_CURRENT = 1;
const ET_EXEC = 2;
const ET_DYN = 3;
const EM_X86_64 = 62;
const EM_AARCH64 = 183;
const PT_INTERP = 3;

const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_EXECUTABLE_IMAGE = 0x0002;
const IMAGE_FILE_DLL = 0x2000;
const PE32_PLUS_MAGIC = 0x020b;

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function readRegularFile(filePath, { nonEmpty = false } = {}) {
  const st = lstatSync(filePath);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Expected regular non-symlink file: ${filePath}`);
  }
  const bytes = readFileSync(filePath);
  if (nonEmpty && bytes.length === 0) {
    throw new Error(`Expected non-empty regular file: ${filePath}`);
  }
  return bytes;
}

export function assertNonEmptyKnownString(value, fieldName) {
  if (typeof value !== 'string') {
    throw new Error(`Expected string for ${fieldName}.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === 'unknown') {
    throw new Error(`Invalid or unknown value for ${fieldName}: '${value}'.`);
  }
  return trimmed;
}

export function assertSafeChildPath(root, relPath) {
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

export function inspectExecutableContainer(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error('Executable payload must be a non-empty buffer.');
  }

  if (bytes.length >= 4) {
    const beMagic = bytes.readUInt32BE(0);
    if (beMagic === FAT_MAGIC || beMagic === FAT_CIGAM) {
      throw new Error('Universal/Fat Mach-O binaries are unsupported; provide thin single-architecture executable.');
    }
    const leMagic = bytes.readUInt32LE(0);
    if (leMagic === MH_MAGIC_64) {
      if (bytes.length < 32) {
        throw new Error('Truncated 64-bit Mach-O header.');
      }
      const cpuType = bytes.readInt32LE(4);
      const fileType = bytes.readUInt32LE(12);
      const sizeOfCmds = bytes.readUInt32LE(20);
      if (32 + sizeOfCmds > bytes.length) {
        throw new Error('Truncated Mach-O load commands.');
      }
      if (fileType !== MH_EXECUTE) {
        throw new Error(`Mach-O filetype must be MH_EXECUTE (2), got ${fileType}.`);
      }
      let arch = null;
      if (cpuType === CPU_TYPE_ARM64) {
        arch = 'arm64';
      } else if (cpuType === CPU_TYPE_X86_64) {
        arch = 'x64';
      } else {
        throw new Error(`Unsupported Mach-O cputype: 0x${(cpuType >>> 0).toString(16)}.`);
      }
      return {
        containerFormat: 'macho-64',
        arch,
        executableType: 'MH_EXECUTE',
        dynamicLinker: null,
      };
    }
  }

  if (
    bytes.length >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  ) {
    if (bytes.length < 64) {
      throw new Error('Truncated ELF64 header.');
    }
    if (bytes[4] !== ELF_CLASS_64 || bytes[5] !== ELF_DATA_LSB || bytes[6] !== ELF_VERSION_CURRENT) {
      throw new Error(
        `Unsupported ELF class/endianness/version: class=${bytes[4]}, data=${bytes[5]}, version=${bytes[6]}.`,
      );
    }
    const eType = bytes.readUInt16LE(16);
    if (eType !== ET_EXEC && eType !== ET_DYN) {
      throw new Error(`ELF e_type must be ET_EXEC (2) or ET_DYN (3), got ${eType}.`);
    }
    const eMachine = bytes.readUInt16LE(18);
    let arch = null;
    if (eMachine === EM_X86_64) {
      arch = 'x64';
    } else if (eMachine === EM_AARCH64) {
      arch = 'arm64';
    } else {
      throw new Error(`Unsupported ELF e_machine: ${eMachine}.`);
    }
    const eEhSize = bytes.readUInt16LE(52);
    if (eEhSize < 64) {
      throw new Error(`Invalid ELF64 e_ehsize: ${eEhSize}.`);
    }

    let dynamicLinker = null;
    const ePhOff = Number(bytes.readBigUInt64LE(32));
    const ePhEntSize = bytes.readUInt16LE(54);
    const ePhNum = bytes.readUInt16LE(56);
    if (ePhNum > 0) {
      if (
        ePhEntSize < 56 ||
        !Number.isSafeInteger(ePhOff) ||
        ePhOff + ePhNum * ePhEntSize > bytes.length
      ) {
        throw new Error('Truncated or malformed ELF64 program header table.');
      }
      for (let i = 0; i < ePhNum; i += 1) {
        const off = ePhOff + i * ePhEntSize;
        const pType = bytes.readUInt32LE(off);
        if (pType === PT_INTERP) {
          const pOffset = Number(bytes.readBigUInt64LE(off + 8));
          const pFileSz = Number(bytes.readBigUInt64LE(off + 32));
          if (
            !Number.isSafeInteger(pOffset) ||
            !Number.isSafeInteger(pFileSz) ||
            pOffset + pFileSz > bytes.length
          ) {
            throw new Error('Truncated ELF64 PT_INTERP segment.');
          }
          dynamicLinker = bytes
            .subarray(pOffset, pOffset + pFileSz)
            .toString('utf8')
            .replace(/\0+$/, '');
          break;
        }
      }
    }

    return {
      containerFormat: 'elf-64',
      arch,
      executableType: eType === ET_EXEC ? 'ET_EXEC' : 'ET_DYN',
      dynamicLinker,
    };
  }

  if (bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const peOffset = bytes.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset + 26 > bytes.length) {
      throw new Error('Truncated or invalid PE e_lfanew header offset.');
    }
    if (
      bytes[peOffset] !== 0x50 ||
      bytes[peOffset + 1] !== 0x45 ||
      bytes[peOffset + 2] !== 0x00 ||
      bytes[peOffset + 3] !== 0x00
    ) {
      throw new Error('Missing PE signature at e_lfanew.');
    }
    const machine = bytes.readUInt16LE(peOffset + 4);
    if (machine !== IMAGE_FILE_MACHINE_AMD64) {
      throw new Error(`Unsupported PE machine type: 0x${machine.toString(16)}.`);
    }
    const sizeOfOptionalHeader = bytes.readUInt16LE(peOffset + 20);
    if (sizeOfOptionalHeader < 2 || peOffset + 24 + sizeOfOptionalHeader > bytes.length) {
      throw new Error('Truncated PE optional header.');
    }
    const characteristics = bytes.readUInt16LE(peOffset + 22);
    if ((characteristics & IMAGE_FILE_EXECUTABLE_IMAGE) === 0 || (characteristics & IMAGE_FILE_DLL) !== 0) {
      throw new Error(
        `PE file must be an executable image and not a DLL (characteristics=0x${characteristics.toString(16)}).`,
      );
    }
    const optMagic = bytes.readUInt16LE(peOffset + 24);
    if (optMagic !== PE32_PLUS_MAGIC) {
      throw new Error(`Unsupported PE optional header magic: 0x${optMagic.toString(16)}.`);
    }
    return {
      containerFormat: 'pe-64',
      arch: 'x64',
      executableType: 'PE32+',
      dynamicLinker: null,
    };
  }

  throw new Error('Unrecognized or non-native executable container format.');
}

export function assertExecutableMatchesTarget(bytes, targetMeta) {
  const container = inspectExecutableContainer(bytes);
  if (container.containerFormat !== targetMeta.executableFormat || container.arch !== targetMeta.arch) {
    throw new Error(
      `Executable format/architecture mismatch for '${targetMeta.tuple}': expected ${targetMeta.executableFormat}/${targetMeta.arch}, got ${container.containerFormat}/${container.arch}.`,
    );
  }
  if (targetMeta.libc === 'musl-static' && container.dynamicLinker) {
    if (container.dynamicLinker.includes('ld-linux')) {
      throw new Error(
        `Target '${targetMeta.tuple}' requires musl-static linkage, but ELF PT_INTERP specifies glibc '${container.dynamicLinker}'.`,
      );
    }
  }
  return container;
}

export function extractEmbeddedBuildIdentity(bytes) {
  const firstIdx = bytes.indexOf(IDENTITY_PREFIX);
  if (firstIdx === -1) {
    throw new Error('Binary lacks authoritative CLEC_BUILD_IDENTITY_V1 compile metadata.');
  }
  const secondIdx = bytes.indexOf(IDENTITY_PREFIX, firstIdx + IDENTITY_PREFIX.length);
  if (secondIdx !== -1) {
    throw new Error('Binary contains duplicate CLEC_BUILD_IDENTITY_V1 metadata markers.');
  }
  const jsonStart = firstIdx + IDENTITY_PREFIX.length;
  const endIdx = bytes.indexOf(IDENTITY_SUFFIX, jsonStart);
  if (endIdx === -1) {
    throw new Error('Truncated CLEC_BUILD_IDENTITY_V1 compile metadata.');
  }

  let parsed;
  try {
    parsed = JSON.parse(bytes.subarray(jsonStart, endIdx).toString('utf8'));
  } catch (err) {
    throw new Error(`Malformed CLEC_BUILD_IDENTITY_V1 JSON: ${err.message}`);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    parsed.schemaVersion !== 1 ||
    parsed.packageName !== NATIVE_CRATE_NAME ||
    typeof parsed.packageVersion !== 'string' ||
    parsed.packageVersion.length === 0 ||
    !VALID_ARTIFACT_KINDS.has(parsed.artifactKind) ||
    typeof parsed.target !== 'string' ||
    parsed.target.length === 0 ||
    typeof parsed.profile !== 'string' ||
    parsed.profile.length === 0 ||
    !Array.isArray(parsed.features) ||
    !parsed.features.every((f) => typeof f === 'string' && f.length > 0) ||
    typeof parsed.testHooks !== 'boolean' ||
    typeof parsed.rustcVersion !== 'string' ||
    parsed.rustcVersion.length === 0 ||
    typeof parsed.cargoLockSha256 !== 'string' ||
    !HEX_64.test(parsed.cargoLockSha256)
  ) {
    throw new Error('Embedded CLEC_BUILD_IDENTITY_V1 metadata fails schema validation.');
  }

  if (parsed.testHooks !== parsed.features.includes('test-hooks')) {
    throw new Error('Embedded CLEC_BUILD_IDENTITY_V1 testHooks flag contradicts features list.');
  }

  return parsed;
}

export function assertReleaseBuildIdentity(identity, expectedKind, expectedVersion, expectedRustTarget) {
  if (identity.testHooks || identity.features.includes('test-hooks')) {
    throw new Error(
      `Refusing binary compiled with test-hooks feature (artifactKind='${identity.artifactKind}', features=${JSON.stringify(identity.features)}).`,
    );
  }
  if (identity.artifactKind !== expectedKind) {
    throw new Error(
      `Binary artifactKind mismatch: expected '${expectedKind}', got '${identity.artifactKind}'.`,
    );
  }
  if (identity.packageVersion !== expectedVersion) {
    throw new Error(
      `Binary packageVersion mismatch: expected '${expectedVersion}', got '${identity.packageVersion}'.`,
    );
  }
  if (identity.target !== expectedRustTarget) {
    throw new Error(
      `Binary Rust target mismatch: expected '${expectedRustTarget}', got '${identity.target}'.`,
    );
  }
  if (identity.profile !== 'release') {
    throw new Error(`Binary profile must be 'release', got '${identity.profile}'.`);
  }
  if (identity.features.length !== 0) {
    throw new Error(
      `Release binary must have empty Cargo features, got ${JSON.stringify(identity.features)}.`,
    );
  }
}

function identitiesEqual(a, b) {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }
  return (
    a.schemaVersion === b.schemaVersion &&
    a.packageName === b.packageName &&
    a.packageVersion === b.packageVersion &&
    a.artifactKind === b.artifactKind &&
    a.target === b.target &&
    a.profile === b.profile &&
    a.testHooks === b.testHooks &&
    a.rustcVersion === b.rustcVersion &&
    a.cargoLockSha256 === b.cargoLockSha256 &&
    Array.isArray(a.features) &&
    Array.isArray(b.features) &&
    a.features.length === b.features.length &&
    a.features.every((item, idx) => item === b.features[idx])
  );
}

export function validateBuildReceipt(receipt, targetMeta, expectedPackageVersion, expectedCargoLockSha256 = null) {
  if (
    typeof receipt !== 'object' ||
    receipt === null ||
    receipt.schemaVersion !== 1 ||
    receipt.receiptKind !== 'clec-build-receipt' ||
    receipt.trustModel !== 'unsigned-local-build-receipt'
  ) {
    throw new Error('Build receipt must declare schemaVersion=1, receiptKind="clec-build-receipt", trustModel="unsigned-local-build-receipt".');
  }
  if (receipt.packageName !== PACKAGE_NAME || receipt.packageVersion !== expectedPackageVersion) {
    throw new Error(
      `Build receipt package mismatch: expected ${PACKAGE_NAME}@${expectedPackageVersion}, got ${receipt.packageName}@${receipt.packageVersion}.`,
    );
  }
  if (receipt.tuple !== targetMeta.tuple || receipt.rustTarget !== targetMeta.rustTarget) {
    throw new Error(
      `Build receipt target mismatch: expected ${targetMeta.tuple}/${targetMeta.rustTarget}, got ${receipt.tuple}/${receipt.rustTarget}.`,
    );
  }
  if (typeof receipt.sourceCommit !== 'string' || !HEX_40.test(receipt.sourceCommit)) {
    throw new Error(`Build receipt sourceCommit must be a 40-char lowercase hex SHA: '${receipt.sourceCommit}'.`);
  }
  if (typeof receipt.sourceDirty !== 'boolean') {
    throw new Error('Build receipt must include boolean sourceDirty.');
  }
  if (typeof receipt.cargoLockSha256 !== 'string' || !HEX_64.test(receipt.cargoLockSha256)) {
    throw new Error('Build receipt cargoLockSha256 must be a 64-char lowercase hex SHA-256.');
  }
  if (expectedCargoLockSha256 && receipt.cargoLockSha256 !== expectedCargoLockSha256) {
    throw new Error(
      `Build receipt cargoLockSha256 mismatch: expected ${expectedCargoLockSha256}, got ${receipt.cargoLockSha256}.`,
    );
  }
  const rustcVersion = assertNonEmptyKnownString(receipt.rustcVersion, 'buildReceipt.rustcVersion');
  if (!rustcVersion.startsWith('rustc ')) {
    throw new Error(`Build receipt rustcVersion must be a real rustc --version string, got '${rustcVersion}'.`);
  }
  assertNonEmptyKnownString(receipt.buildCommand, 'buildReceipt.buildCommand');
  assertNonEmptyKnownString(receipt.hostBaseline, 'buildReceipt.hostBaseline');
  if (receipt.profile !== 'release') {
    throw new Error(`Build receipt profile must be 'release', got '${receipt.profile}'.`);
  }
  if (!Array.isArray(receipt.features) || receipt.features.length !== 0) {
    throw new Error(`Build receipt features must be empty for release staging, got ${JSON.stringify(receipt.features)}.`);
  }
  if (receipt.testHooksIncluded !== false) {
    throw new Error('Build receipt testHooksIncluded must be false for release staging.');
  }
  if (typeof receipt.artifacts !== 'object' || receipt.artifacts === null || !receipt.artifacts.clec) {
    throw new Error('Build receipt must contain artifacts.clec binding.');
  }
  return receipt;
}

function normalizeExecutionEvidence(raw) {
  if (raw === undefined || raw === null) {
    return {
      status: 'unverified',
      note: 'Structural binary identity and build receipt do not certify cross-OS execution.',
    };
  }
  if (typeof raw === 'string') {
    const trimmed = assertNonEmptyKnownString(raw, 'executionEvidence');
    if (trimmed === 'unverified') {
      return {
        status: 'unverified',
        note: 'Structural binary identity and build receipt do not certify cross-OS execution.',
      };
    }
    return {
      status: trimmed,
      note: 'Caller-recorded local host execution label; does not certify unexecuted target platforms.',
    };
  }
  if (typeof raw === 'object' && typeof raw.status === 'string') {
    const status = assertNonEmptyKnownString(raw.status, 'executionEvidence.status');
    return {
      status,
      note:
        typeof raw.note === 'string' && raw.note.trim().length > 0
          ? raw.note.trim()
          : 'Separate from structural binary identity.',
    };
  }
  throw new Error('Invalid executionEvidence field.');
}

function admitSingleBinary(slotKey, binaryPath, expectedKind, expectedBinaryName, targetMeta, receipt, expectedPackageVersion) {
  const bytes = readRegularFile(resolve(binaryPath), { nonEmpty: true });
  const actualSha = sha256Hex(bytes);
  const container = assertExecutableMatchesTarget(bytes, targetMeta);
  const embedded = extractEmbeddedBuildIdentity(bytes);
  assertReleaseBuildIdentity(embedded, expectedKind, expectedPackageVersion, targetMeta.rustTarget);

  if (embedded.rustcVersion !== receipt.rustcVersion) {
    throw new Error(
      `Compiler mismatch for ${targetMeta.tuple}.${slotKey}: binary embedded '${embedded.rustcVersion}', receipt declared '${receipt.rustcVersion}'.`,
    );
  }
  if (embedded.cargoLockSha256 !== receipt.cargoLockSha256) {
    throw new Error(
      `Cargo.lock SHA-256 mismatch for ${targetMeta.tuple}.${slotKey}: binary embedded '${embedded.cargoLockSha256}', receipt declared '${receipt.cargoLockSha256}'.`,
    );
  }

  const bound = receipt.artifacts[slotKey];
  if (typeof bound !== 'object' || bound === null) {
    throw new Error(`Build receipt for '${targetMeta.tuple}' lacks bound entry for '${slotKey}'.`);
  }
  if (bound.kind !== expectedKind || bound.binaryName !== expectedBinaryName) {
    throw new Error(
      `Build receipt slot '${slotKey}' metadata mismatch: expected ${expectedKind}/${expectedBinaryName}, got ${bound.kind}/${bound.binaryName}.`,
    );
  }
  if (bound.bytes !== bytes.length) {
    throw new Error(
      `Build receipt byte length mismatch for ${targetMeta.tuple}.${slotKey}: receipt=${bound.bytes}, payload=${bytes.length}.`,
    );
  }
  if (bound.sha256 !== actualSha) {
    throw new Error(
      `Build receipt SHA-256 mismatch for ${targetMeta.tuple}.${slotKey}: receipt=${bound.sha256}, payload=${actualSha}.`,
    );
  }
  if (!identitiesEqual(bound.embeddedMetadata, embedded)) {
    throw new Error(
      `Build receipt embeddedMetadata mismatch for ${targetMeta.tuple}.${slotKey}.`,
    );
  }

  return {
    bytes,
    sha256: actualSha,
    container,
    embedded,
  };
}

export function admitTargetArtifacts(targetMeta, supplied, options) {
  if (!supplied || typeof supplied !== 'object') {
    throw new Error(`Target '${targetMeta.tuple}' input entry must be an object.`);
  }
  if (typeof supplied.clec !== 'string' || supplied.clec.trim().length === 0) {
    throw new Error(`Target '${targetMeta.tuple}' must specify 'clec' binary path.`);
  }
  if (typeof supplied.buildReceipt !== 'string' || supplied.buildReceipt.trim().length === 0) {
    throw new Error(`Target '${targetMeta.tuple}' must specify 'buildReceipt' path.`);
  }

  const receiptBytes = readRegularFile(resolve(supplied.buildReceipt), { nonEmpty: true });
  let receiptRaw;
  try {
    receiptRaw = JSON.parse(receiptBytes.toString('utf8'));
  } catch (err) {
    throw new Error(`Malformed buildReceipt JSON for '${targetMeta.tuple}': ${err.message}`);
  }
  const receipt = validateBuildReceipt(
    receiptRaw,
    targetMeta,
    options.packageVersion,
    options.expectedCargoLockSha256 ?? null,
  );
  if (!options.allowPartial && receipt.sourceDirty) {
    throw new Error(
      `Refusing production staging from dirty git working tree for '${targetMeta.tuple}'.`,
    );
  }

  const clec = admitSingleBinary(
    'clec',
    supplied.clec,
    'clec',
    targetMeta.binaryName,
    targetMeta,
    receipt,
    options.packageVersion,
  );

  let maintainer = null;
  if (supplied.clecPublish || supplied.clecValidate) {
    if (!supplied.clecPublish || !supplied.clecValidate) {
      throw new Error(
        `Target '${targetMeta.tuple}' maintainer archive requires both 'clecPublish' and 'clecValidate'.`,
      );
    }
    const [pubName, valName] = targetMeta.maintainerBinaries;
    const clecPublish = admitSingleBinary(
      'clecPublish',
      supplied.clecPublish,
      'clec-publish',
      pubName,
      targetMeta,
      receipt,
      options.packageVersion,
    );
    const clecValidate = admitSingleBinary(
      'clecValidate',
      supplied.clecValidate,
      'clec-validate',
      valName,
      targetMeta,
      receipt,
      options.packageVersion,
    );
    maintainer = { clecPublish, clecValidate };
  }

  const structuralIdentity = {
    containerFormat: clec.container.containerFormat,
    arch: clec.container.arch,
    executableType: clec.container.executableType,
    rustTarget: targetMeta.rustTarget,
    packageVersion: options.packageVersion,
    features: [],
    testHooksIncluded: false,
  };

  return {
    clec,
    maintainer,
    receipt,
    structuralIdentity,
    executionEvidence: normalizeExecutionEvidence(supplied.executionEvidence),
  };
}

export function validateInventoryHeader(inventory) {
  if (
    typeof inventory !== 'object' ||
    inventory === null ||
    inventory.schemaVersion !== 1 ||
    inventory.packageName !== PACKAGE_NAME ||
    inventory.packageVersion !== PACKAGE_VERSION ||
    typeof inventory.complete !== 'boolean' ||
    typeof inventory.publishable !== 'boolean' ||
    typeof inventory.targets !== 'object' ||
    inventory.targets === null
  ) {
    throw new Error('Invalid inventory.json header or version mismatch.');
  }
}

export function validateInventoryTargetEntry(entry, targetMeta) {
  if (!entry || entry.status !== 'present') {
    const reason = entry && entry.reason ? ` (${entry.reason})` : '';
    throw new Error(
      `Bundled binary for '${targetMeta.tuple}' (${targetMeta.rustTarget}) is not included in this package${reason}. Download the direct release archive for your target instead.`,
    );
  }
  assertSafeChildPath('.', entry.payloadPath);
  const expectedPayloadRel = `payloads/${targetMeta.tuple}/${targetMeta.binaryName}`;
  if (
    entry.platform !== targetMeta.platform ||
    entry.arch !== targetMeta.arch ||
    entry.rustTarget !== targetMeta.rustTarget ||
    entry.binaryName !== targetMeta.binaryName ||
    entry.libc !== targetMeta.libc ||
    entry.payloadPath !== expectedPayloadRel
  ) {
    throw new Error(
      `Inventory metadata mismatch for tuple '${targetMeta.tuple}': expected ${targetMeta.platform}/${targetMeta.arch}/${targetMeta.rustTarget}/${targetMeta.binaryName}/${targetMeta.libc} at ${expectedPayloadRel}.`,
    );
  }
  if (
    typeof entry.bytes !== 'number' ||
    !Number.isInteger(entry.bytes) ||
    entry.bytes <= 0 ||
    typeof entry.sha256 !== 'string' ||
    !HEX_64.test(entry.sha256)
  ) {
    throw new Error(`Invalid inventory byte/checksum metadata for tuple '${targetMeta.tuple}'.`);
  }
  if (entry.structuralIdentity !== undefined) {
    const si = entry.structuralIdentity;
    if (
      typeof si !== 'object' ||
      si === null ||
      si.containerFormat !== targetMeta.executableFormat ||
      si.arch !== targetMeta.arch ||
      si.rustTarget !== targetMeta.rustTarget ||
      si.packageVersion !== PACKAGE_VERSION ||
      si.testHooksIncluded !== false ||
      !Array.isArray(si.features) ||
      si.features.length !== 0
    ) {
      throw new Error(`Invalid structuralIdentity metadata for tuple '${targetMeta.tuple}'.`);
    }
  }
}
