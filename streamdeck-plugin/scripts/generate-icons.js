/*
 * Generates minimal placeholder PNG icons for the Stream Deck plugin so the
 * manifest references resolve. Replace these with real artwork any time.
 *
 * Produces solid-colour PNGs with only Node built-ins (zlib + a tiny CRC32),
 * so it never needs an external dependency.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function solidPng(width, height, [r, g, b]) {
  const rowBytes = width * 3;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const off = y * (rowBytes + 1);
    raw[off] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const p = off + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, "..", "assets");
fs.mkdirSync(outDir, { recursive: true });

const icons = {
  "plugin.png": solidPng(288, 288, [243, 156, 18]), // accent orange
  "scene.png": solidPng(144, 144, [27, 30, 33]), // dark surface
  "scene-active.png": solidPng(144, 144, [243, 156, 18]), // accent orange (highlight)
};

for (const [name, data] of Object.entries(icons)) {
  fs.writeFileSync(path.join(outDir, name), data);
  console.log("wrote", path.join(outDir, name), `(${data.length} bytes)`);
}
