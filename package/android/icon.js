// Draws Aria's icon (dark rounded square, white ring, white dot) at every
// Android density and writes plain PNGs. No image libraries needed.
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
}

function png(size, px) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    px.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function icon(size) {
  const px = Buffer.alloc(size * size * 4);
  const rad = 0.23 * size;
  const cx = size / 2;
  const cy = size / 2;
  const inRect = (x, y) => {
    const l = rad;
    const r = size - rad;
    if (x >= l && x <= r) return y >= 0 && y <= size;
    const qx = x < l ? l - x : x > r ? x - r : 0;
    const qy = y < l ? l - y : y > r ? y - r : 0;
    return qx * qx + qy * qy <= rad * rad;
  };
  const ringOuter = 0.3 * size;
  const ringWidth = 0.052 * size;
  const dot = 0.085 * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0;
      let white = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const px1 = x + (sx + 0.5) / 3;
          const py1 = y + (sy + 0.5) / 3;
          if (!inRect(px1, py1)) continue;
          covered++;
          const d = Math.hypot(px1 - cx, py1 - cy);
          if ((d <= ringOuter && d >= ringOuter - ringWidth) || d <= dot) white++;
        }
      }
      const a = covered / 9;
      if (a === 0) continue;
      const mix = white / covered;
      const v = Math.round(22 + (255 - 22) * mix);
      const i = (y * size + x) * 4;
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
      px[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, px);
}

const out = process.argv[2];
const sizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const key of Object.keys(sizes)) {
  const dir = path.join(out, "mipmap-" + key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ic_launcher.png"), icon(sizes[key]));
}
fs.writeFileSync(path.join(out, "icon-512.png"), icon(512));
console.log("icons written to " + out);
