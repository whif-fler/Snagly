'use strict';

const fs = require('fs');
const { once } = require('events');

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

function crc32(buffer, previous = 0) {
  const table = crcTable();
  let c = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buffer.length; i++) c = table[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

async function writeChunk(res, chunk) {
  if (res.destroyed) throw new Error('Client disconnected');
  if (!res.write(chunk)) {
    await once(res, 'drain');
    if (res.destroyed) throw new Error('Client disconnected');
  }
}

/**
 * Streaming ZIP writer using stored (uncompressed) entries. Media is already
 * compressed, so this avoids buffering an entire playlist in memory while
 * keeping the implementation dependency-free. ZIP64 is not used; the caller
 * enforces a total-size ceiling well below 4 GiB.
 */
async function streamZip(res, entries) {
  let offset = 0;
  const central = [];

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (!name.length || name.length > 512) continue;
    const { time, date } = dosDateTime(entry.mtimeMs);
    let crc = 0;
    let size = 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 name
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const localOffset = offset;
    await writeChunk(res, local);
    await writeChunk(res, name);
    offset += local.length + name.length;

    const stream = fs.createReadStream(entry.path);
    try {
      for await (const chunk of stream) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        await writeChunk(res, chunk);
      }
    } finally {
      stream.destroy();
    }
    offset += size;

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    await writeChunk(res, descriptor);
    offset += descriptor.length;

    central.push({ name, crc, size, time, date, offset: localOffset });
  }

  const centralOffset = offset;
  for (const entry of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0808, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.date, 14);
    header.writeUInt32LE(entry.crc >>> 0, 16);
    header.writeUInt32LE(entry.size, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(entry.offset, 42);
    await writeChunk(res, header);
    await writeChunk(res, entry.name);
    offset += header.length + entry.name.length;
  }
  const centralSize = offset - centralOffset;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  await writeChunk(res, end);
}

module.exports = { streamZip, crc32 };
