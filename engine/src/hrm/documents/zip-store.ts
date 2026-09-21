/**
 * Minimal stored (uncompressed) ZIP writer — pure, dependency-free.
 *
 * The DSAR export needs a real .zip the subject can open anywhere, and
 * HRM evidence must not gain a compression dependency for one artifact.
 * Stored entries (method 0) with CRC32 and a central directory open in
 * every unzipper; compression buys nothing on JSON + PDFs here. Pure so
 * unit tests exercise the exact bytes the worker writes.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v & 0xffff, 0);
  return b;
}

function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
}

/** Build a stored ZIP. Names must be unique, non-empty, UTF-8, slash-separated. */
export function buildStoredZip(entries: ZipEntry[]): Buffer {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.name || entry.name.includes("\\") || entry.name.startsWith("/")) {
      throw new Error(`zip entry name ${JSON.stringify(entry.name)} is not a portable path`);
    }
    if (seen.has(entry.name)) {
      throw new Error(`zip entry name ${JSON.stringify(entry.name)} is duplicated`);
    }
    seen.add(entry.name);
  }
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const header = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800), // UTF-8 names
      u16(0), // stored
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
    ]);
    chunks.push(header, data);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(nameBuf.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBuf,
      ]),
    );
    offset += header.length + data.length;
  }
  const centralStart = offset;
  const centralDir = Buffer.concat(central);
  chunks.push(centralDir);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(centralStart),
    u16(0),
  ]);
  chunks.push(end);
  return Buffer.concat(chunks);
}
