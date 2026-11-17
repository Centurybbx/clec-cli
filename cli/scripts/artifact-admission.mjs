import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { NATIVE_CRATE_NAME, PACKAGE_NAME, PACKAGE_VERSION } from './targets.mjs';

export const IDENTITY_PREFIX = Buffer.from('\0CLEC_BUILD_IDENTITY_V1\0', 'utf8');
export const IDENTITY_SUFFIX = Buffer.from('\0END_CLEC_BUILD_IDENTITY_V1\0', 'utf8');
export const RECEIPT_SCHEMA_VERSION = 2;
export const INVENTORY_SCHEMA_VERSION = 2;
export const PROVENANCE_SCHEMA_VERSION = 2;
export const INSPECTED_PREBUILT_RECEIPT_KIND = 'clec-inspected-prebuilt-receipt';
export const CONTROLLED_BUILD_RECEIPT_KIND = 'clec-controlled-build-receipt';
export const NOT_VERIFIED_UNKNOWN = 'not_verified_unknown';
export const ESTABLISHED_SOURCE = 'established_local_git_checkout';
export const ESTABLISHED_BUILD = 'established_local_cargo_execution';
export const PROVENANCE_CLASSIFICATIONS = new Set([
  'controlled-executed-build',
  'inspected-prebuilt',
  'mixed-controlled-and-inspected-prebuilt',
]);

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
  if (targetMeta.libc === 'musl-static' && container.dynamicLinker !== null) {
    throw new Error(
      `Target '${targetMeta.tuple}' requires musl-static linkage without an ELF PT_INTERP segment.`,
    );
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

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSourceProvenance(raw, fieldName = 'provenance.source') {
  if (!isPlainObject(raw)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  if (raw.status === NOT_VERIFIED_UNKNOWN) {
    if ('sourceCommit' in raw || 'sourceDirty' in raw) {
      throw new Error(`${fieldName} with status '${NOT_VERIFIED_UNKNOWN}' must not include sourceCommit or sourceDirty.`);
    }
    return {
      status: NOT_VERIFIED_UNKNOWN,
      reason: assertNonEmptyKnownString(raw.reason, `${fieldName}.reason`),
    };
  }
  if (raw.status === ESTABLISHED_SOURCE) {
    if (typeof raw.sourceCommit !== 'string' || !HEX_40.test(raw.sourceCommit)) {
      throw new Error(`${fieldName}.sourceCommit must be a 40-char lowercase hex SHA: '${raw.sourceCommit}'.`);
    }
    if (typeof raw.sourceDirty !== 'boolean') {
      throw new Error(`${fieldName}.sourceDirty must be a boolean.`);
    }
    return {
      status: ESTABLISHED_SOURCE,
      sourceCommit: raw.sourceCommit,
      sourceDirty: raw.sourceDirty,
    };
  }
  throw new Error(`${fieldName}.status must be '${ESTABLISHED_SOURCE}' or '${NOT_VERIFIED_UNKNOWN}', got '${raw.status}'.`);
}

export function parseBuildInvocationProvenance(
  raw,
  fieldName = 'provenance.buildInvocation',
  { requireArgv = true } = {},
) {
  if (!isPlainObject(raw)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  if (raw.status === NOT_VERIFIED_UNKNOWN) {
    if ('executable' in raw || 'argv' in raw || 'command' in raw || 'hostBaseline' in raw) {
      throw new Error(
        `${fieldName} with status '${NOT_VERIFIED_UNKNOWN}' must not include executable, argv, command, or hostBaseline.`,
      );
    }
    return {
      status: NOT_VERIFIED_UNKNOWN,
      reason: assertNonEmptyKnownString(raw.reason, `${fieldName}.reason`),
    };
  }
  if (raw.status === ESTABLISHED_BUILD) {
    const command = assertNonEmptyKnownString(raw.command, `${fieldName}.command`);
    const hostBaseline = assertNonEmptyKnownString(raw.hostBaseline, `${fieldName}.hostBaseline`);
    if (requireArgv) {
      if (raw.executable !== 'cargo') {
        throw new Error(`${fieldName}.executable must be 'cargo', got '${raw.executable}'.`);
      }
      if (
        !Array.isArray(raw.argv) ||
        raw.argv.length === 0 ||
        !raw.argv.every((arg) => typeof arg === 'string' && arg.length > 0 && arg.trim().toLowerCase() !== 'unknown')
      ) {
        throw new Error(`${fieldName}.argv must be a non-empty array of known command arguments.`);
      }
      const expectedCommand = ['cargo', ...raw.argv].join(' ');
      if (command !== expectedCommand) {
        throw new Error(`${fieldName}.command must match executed cargo argv.`);
      }
      return {
        status: ESTABLISHED_BUILD,
        executable: 'cargo',
        argv: [...raw.argv],
        command,
        hostBaseline,
      };
    }
    return {
      status: ESTABLISHED_BUILD,
      command,
      hostBaseline,
    };
  }
  throw new Error(`${fieldName}.status must be '${ESTABLISHED_BUILD}' or '${NOT_VERIFIED_UNKNOWN}', got '${raw.status}'.`);
}

export function parseTargetProvenance(raw, fieldName = 'provenance', options = {}) {
  if (!isPlainObject(raw)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  return {
    source: parseSourceProvenance(raw.source, `${fieldName}.source`),
    buildInvocation: parseBuildInvocationProvenance(raw.buildInvocation, `${fieldName}.buildInvocation`, options),
  };
}

function parseCaptureObservation(raw) {
  if (!isPlainObject(raw)) {
    throw new Error('Inspected prebuilt receipt must contain a captureObservation object.');
  }
  let observedGit = null;
  if (raw.observedGit !== null && raw.observedGit !== undefined) {
    if (!isPlainObject(raw.observedGit)) {
      throw new Error('captureObservation.observedGit must be null or an object.');
    }
    if (typeof raw.observedGit.commit !== 'string' || !HEX_40.test(raw.observedGit.commit)) {
      throw new Error('captureObservation.observedGit.commit must be a 40-char lowercase hex SHA.');
    }
    if (typeof raw.observedGit.dirty !== 'boolean') {
      throw new Error('captureObservation.observedGit.dirty must be a boolean.');
    }
    observedGit = {
      commit: raw.observedGit.commit,
      dirty: raw.observedGit.dirty,
    };
  }
  const declaredBuildCommand =
    raw.declaredBuildCommand === null || raw.declaredBuildCommand === undefined
      ? null
      : assertNonEmptyKnownString(raw.declaredBuildCommand, 'captureObservation.declaredBuildCommand');
  const declaredHostBaseline =
    raw.declaredHostBaseline === null || raw.declaredHostBaseline === undefined
      ? null
      : assertNonEmptyKnownString(raw.declaredHostBaseline, 'captureObservation.declaredHostBaseline');
  return {
    observedGit,
    declaredBuildCommand,
    declaredHostBaseline,
  };
}

function parseVerifiedEmbeddedMetadata(raw, expectedCargoLockSha256 = null) {
  if (!isPlainObject(raw)) {
    throw new Error('verifiedEmbeddedMetadata must be an object.');
  }
  if (typeof raw.cargoLockSha256 !== 'string' || !HEX_64.test(raw.cargoLockSha256)) {
    throw new Error('verifiedEmbeddedMetadata.cargoLockSha256 must be a 64-char lowercase hex SHA-256.');
  }
  if (expectedCargoLockSha256 && raw.cargoLockSha256 !== expectedCargoLockSha256) {
    throw new Error(
      `verifiedEmbeddedMetadata.cargoLockSha256 mismatch: expected ${expectedCargoLockSha256}, got ${raw.cargoLockSha256}.`,
    );
  }
  const rustcVersion = assertNonEmptyKnownString(
    raw.rustcVersion,
    'verifiedEmbeddedMetadata.rustcVersion',
  );
  if (!rustcVersion.startsWith('rustc ')) {
    throw new Error(
      `verifiedEmbeddedMetadata.rustcVersion must be a real rustc --version string, got '${rustcVersion}'.`,
    );
  }
  if (raw.profile !== 'release') {
    throw new Error(`verifiedEmbeddedMetadata.profile must be 'release', got '${raw.profile}'.`);
  }
  if (!Array.isArray(raw.features) || raw.features.length !== 0) {
    throw new Error(
      `verifiedEmbeddedMetadata.features must be empty for release staging, got ${JSON.stringify(raw.features)}.`,
    );
  }
  if (raw.testHooksIncluded !== false) {
    throw new Error('verifiedEmbeddedMetadata.testHooksIncluded must be false for release staging.');
  }
  return {
    cargoLockSha256: raw.cargoLockSha256,
    rustcVersion,
    profile: raw.profile,
    features: [],
    testHooksIncluded: false,
  };
}

export function validateBuildReceipt(receipt, targetMeta, expectedPackageVersion, expectedCargoLockSha256 = null) {
  if (!isPlainObject(receipt)) {
    throw new Error('Build receipt must be a JSON object.');
  }
  if (
    'sourceCommit' in receipt ||
    'sourceDirty' in receipt ||
    'buildCommand' in receipt ||
    'hostBaseline' in receipt ||
    receipt.receiptKind === 'clec-build-receipt'
  ) {
    throw new Error(
      `Legacy unverified build receipt shape is unsupported; expected schemaVersion=${RECEIPT_SCHEMA_VERSION} '${INSPECTED_PREBUILT_RECEIPT_KIND}' or '${CONTROLLED_BUILD_RECEIPT_KIND}'.`,
    );
  }
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    throw new Error(
      `Build receipt schemaVersion must be ${RECEIPT_SCHEMA_VERSION}, got '${receipt.schemaVersion}'.`,
    );
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
  const verifiedEmbeddedMetadata = parseVerifiedEmbeddedMetadata(
    receipt.verifiedEmbeddedMetadata,
    expectedCargoLockSha256,
  );
  if (typeof receipt.artifacts !== 'object' || receipt.artifacts === null || !receipt.artifacts.clec) {
    throw new Error('Build receipt must contain artifacts.clec binding.');
  }

  const provenance = parseTargetProvenance(receipt.provenance, 'buildReceipt.provenance');

  if (receipt.receiptKind === INSPECTED_PREBUILT_RECEIPT_KIND) {
    if (receipt.trustModel !== 'unsigned-inspected-prebuilt-receipt') {
      throw new Error(
        `Inspected prebuilt receipt trustModel must be 'unsigned-inspected-prebuilt-receipt', got '${receipt.trustModel}'.`,
      );
    }
    if (
      provenance.source.status !== NOT_VERIFIED_UNKNOWN ||
      provenance.buildInvocation.status !== NOT_VERIFIED_UNKNOWN
    ) {
      throw new Error(
        `Inspected prebuilt receipt must keep provenance.source and provenance.buildInvocation as '${NOT_VERIFIED_UNKNOWN}'.`,
      );
    }
    return {
      ...receipt,
      provenance,
      captureObservation: parseCaptureObservation(receipt.captureObservation),
      verifiedEmbeddedMetadata,
    };
  }

  if (receipt.receiptKind === CONTROLLED_BUILD_RECEIPT_KIND) {
    if (receipt.trustModel !== 'unsigned-local-controlled-build-receipt') {
      throw new Error(
        `Controlled build receipt trustModel must be 'unsigned-local-controlled-build-receipt', got '${receipt.trustModel}'.`,
      );
    }
    if ('captureObservation' in receipt && receipt.captureObservation !== undefined) {
      throw new Error('Controlled build receipt must not contain captureObservation.');
    }
    if (
      provenance.source.status !== ESTABLISHED_SOURCE ||
      provenance.buildInvocation.status !== ESTABLISHED_BUILD
    ) {
      throw new Error(
        `Controlled build receipt must establish provenance.source ('${ESTABLISHED_SOURCE}') and provenance.buildInvocation ('${ESTABLISHED_BUILD}').`,
      );
    }
    return {
      ...receipt,
      provenance,
      verifiedEmbeddedMetadata,
    };
  }

  throw new Error(
    `Build receipt receiptKind must be '${INSPECTED_PREBUILT_RECEIPT_KIND}' or '${CONTROLLED_BUILD_RECEIPT_KIND}', got '${receipt.receiptKind}'.`,
  );
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

  if (embedded.rustcVersion !== receipt.verifiedEmbeddedMetadata.rustcVersion) {
    throw new Error(
      `Compiler mismatch for ${targetMeta.tuple}.${slotKey}: binary embedded '${embedded.rustcVersion}', receipt declared '${receipt.verifiedEmbeddedMetadata.rustcVersion}'.`,
    );
  }
  if (embedded.cargoLockSha256 !== receipt.verifiedEmbeddedMetadata.cargoLockSha256) {
    throw new Error(
      `Cargo.lock SHA-256 mismatch for ${targetMeta.tuple}.${slotKey}: binary embedded '${embedded.cargoLockSha256}', receipt declared '${receipt.verifiedEmbeddedMetadata.cargoLockSha256}'.`,
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
  if (
    !options.allowPartial &&
    receipt.provenance.source.status === ESTABLISHED_SOURCE &&
    receipt.provenance.source.sourceDirty
  ) {
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
    !isPlainObject(inventory) ||
    inventory.schemaVersion !== INVENTORY_SCHEMA_VERSION ||
    inventory.packageName !== PACKAGE_NAME ||
    inventory.packageVersion !== PACKAGE_VERSION ||
    typeof inventory.complete !== 'boolean' ||
    inventory.publishable !== false ||
    !isPlainObject(inventory.targets)
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
  parseTargetProvenance(entry.provenance, `inventory.targets['${targetMeta.tuple}'].provenance`);
}

export function validateProvenanceDocument(doc) {
  if (
    !isPlainObject(doc) ||
    doc.schemaVersion !== PROVENANCE_SCHEMA_VERSION ||
    doc.packageName !== PACKAGE_NAME ||
    doc.packageVersion !== PACKAGE_VERSION ||
    typeof doc.complete !== 'boolean' ||
    doc.publishable !== false ||
    !PROVENANCE_CLASSIFICATIONS.has(doc.provenanceClassification) ||
    !isPlainObject(doc.targets)
  ) {
    throw new Error('Invalid provenance.json header or classification.');
  }
  if ('sourceCommit' in doc || 'sourceDirty' in doc || 'buildCommand' in doc || 'hostBaseline' in doc) {
    throw new Error('provenance.json must not emit legacy top-level unverified provenance fields.');
  }
  assertNonEmptyKnownString(doc.trustBoundary, 'provenance.trustBoundary');
  const embedded = doc.verifiedEmbeddedMetadata;
  if (
    !isPlainObject(embedded) ||
    typeof embedded.cargoLockSha256 !== 'string' ||
    !HEX_64.test(embedded.cargoLockSha256) ||
    embedded.profile !== 'release' ||
    !Array.isArray(embedded.features) ||
    embedded.features.length !== 0 ||
    embedded.testHooksIncluded !== false
  ) {
    throw new Error('Invalid provenance.json verifiedEmbeddedMetadata.');
  }
  assertNonEmptyKnownString(embedded.rustcVersion, 'provenance.verifiedEmbeddedMetadata.rustcVersion');
  const topProvenance = parseTargetProvenance(doc.provenance, 'provenance.provenance', {
    requireArgv: false,
  });
  if (doc.provenanceClassification === 'controlled-executed-build') {
    if (
      topProvenance.source.status !== ESTABLISHED_SOURCE ||
      topProvenance.buildInvocation.status !== ESTABLISHED_BUILD
    ) {
      throw new Error('controlled-executed-build provenance must establish source and buildInvocation.');
    }
  } else if (
    topProvenance.source.status !== NOT_VERIFIED_UNKNOWN ||
    topProvenance.buildInvocation.status !== NOT_VERIFIED_UNKNOWN
  ) {
    throw new Error(`${doc.provenanceClassification} provenance must not promote top-level source or buildInvocation.`);
  }
  for (const [tuple, entry] of Object.entries(doc.targets)) {
    if (isPlainObject(entry) && entry.status === 'present') {
      parseTargetProvenance(entry.provenance, `provenance.targets['${tuple}'].provenance`);
    }
  }
  return doc;
}
