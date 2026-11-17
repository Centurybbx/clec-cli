import { deflateRawSync, gzipSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function writeOctal(buf, offset, width, value) {
  const str = value.toString(8).padStart(width - 1, '0');
  if (str.length > width - 1) {
    throw new Error(`Tar numeric field overflow: ${value}`);
  }
  buf.write(str, offset, width - 1, 'ascii');
  buf[offset + width - 1] = 0;
}

function splitTarPath(rawPath) {
  const bytes = Buffer.from(rawPath, 'utf8');
  if (bytes.length <= 100) {
    return { name: bytes, prefix: Buffer.alloc(0) };
  }
  const slash = rawPath.lastIndexOf('/');
  if (slash > 0) {
    const prefix = Buffer.from(rawPath.slice(0, slash), 'utf8');
    const name = Buffer.from(rawPath.slice(slash + 1), 'utf8');
    if (prefix.length <= 155 && name.length <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Path exceeds ustar limits: ${rawPath}`);
}

export function createDeterministicTarGz(entries) {
  const sorted = sortEntries(entries);
  const blocks = [];
  for (const entry of sorted) {
    if (entry.path.startsWith('/') || entry.path.includes('..') || entry.path.includes('\\')) {
      throw new Error(`Unsafe archive entry path: ${entry.path}`);
    }
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const mode = entry.mode ?? (entry.executable ? 0o755 : 0o644);
    const header = Buffer.alloc(512, 0);
    const { name, prefix } = splitTarPath(entry.path);
    name.copy(header, 0);
    writeOctal(header, 100, 8, mode);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.write('ustar', 257, 5, 'ascii');
    header[262] = 0;
    header.write('00', 263, 2, 'ascii');
    prefix.copy(header, 345);

    let checksum = 0;
    for (let i = 0; i < 512; i += 1) {
      checksum += header[i];
    }
    const chkStr = checksum.toString(8).padStart(6, '0');
    header.write(chkStr, 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;

    blocks.push(header);
    if (data.length > 0) {
      blocks.push(data);
      const rem = data.length % 512;
      if (rem !== 0) {
        blocks.push(Buffer.alloc(512 - rem, 0));
      }
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  const tarBuffer = Buffer.concat(blocks);
  const gz = gzipSync(tarBuffer, { level: 9 });
  gz[4] = 0;
  gz[5] = 0;
  gz[6] = 0;
  gz[7] = 0;
  gz[9] = 3;
  return gz;
}

export function createDeterministicZip(entries) {
  const sorted = sortEntries(entries);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = 0x0021;

  for (const entry of sorted) {
    if (entry.path.startsWith('/') || entry.path.includes('..') || entry.path.includes('\\')) {
      throw new Error(`Unsafe archive entry path: ${entry.path}`);
    }
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const nameBuf = Buffer.from(entry.path, 'utf8');
    const crc = crc32(raw);
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : raw;
    const mode = entry.mode ?? (entry.executable ? 0o755 : 0o644);
    const extAttrs = ((0o100000 | mode) << 16) >>> 0;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(extAttrs, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    localParts.push(local, payload);
    centralParts.push(central);
    offset += local.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}
