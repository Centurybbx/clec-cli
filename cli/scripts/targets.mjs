export const PACKAGE_NAME = '@clec/cli';
export const PACKAGE_VERSION = '1.0.0-dev.0';
export const NATIVE_CRATE_NAME = 'clec-native';
export const COMMAND_NAME = 'clec';
export const BIN_TARGET_REL = 'bin/clec.exe';

export const TARGET_MATRIX = Object.freeze([
  Object.freeze({
    tuple: 'darwin-arm64',
    platform: 'darwin',
    arch: 'arm64',
    rustTarget: 'aarch64-apple-darwin',
    binaryName: 'clec',
    maintainerBinaries: Object.freeze(['clec-publish', 'clec-validate']),
    archiveFormat: 'tar.gz',
    libc: 'apple-dyld',
    executableFormat: 'macho-64',
  }),
  Object.freeze({
    tuple: 'darwin-x64',
    platform: 'darwin',
    arch: 'x64',
    rustTarget: 'x86_64-apple-darwin',
    binaryName: 'clec',
    maintainerBinaries: Object.freeze(['clec-publish', 'clec-validate']),
    archiveFormat: 'tar.gz',
    libc: 'apple-dyld',
    executableFormat: 'macho-64',
  }),
  Object.freeze({
    tuple: 'linux-x64',
    platform: 'linux',
    arch: 'x64',
    rustTarget: 'x86_64-unknown-linux-musl',
    binaryName: 'clec',
    maintainerBinaries: Object.freeze(['clec-publish', 'clec-validate']),
    archiveFormat: 'tar.gz',
    libc: 'musl-static',
    executableFormat: 'elf-64',
  }),
  Object.freeze({
    tuple: 'linux-arm64',
    platform: 'linux',
    arch: 'arm64',
    rustTarget: 'aarch64-unknown-linux-musl',
    binaryName: 'clec',
    maintainerBinaries: Object.freeze(['clec-publish', 'clec-validate']),
    archiveFormat: 'tar.gz',
    libc: 'musl-static',
    executableFormat: 'elf-64',
  }),
  Object.freeze({
    tuple: 'win32-x64',
    platform: 'win32',
    arch: 'x64',
    rustTarget: 'x86_64-pc-windows-msvc',
    binaryName: 'clec.exe',
    maintainerBinaries: Object.freeze(['clec-publish.exe', 'clec-validate.exe']),
    archiveFormat: 'zip',
    libc: 'msvc',
    executableFormat: 'pe-64',
  }),
]);

export function findTargetByPlatformArch(platform, arch) {
  return TARGET_MATRIX.find((entry) => entry.platform === platform && entry.arch === arch) ?? null;
}

export function findTargetByTuple(tuple) {
  return TARGET_MATRIX.find((entry) => entry.tuple === tuple) ?? null;
}
