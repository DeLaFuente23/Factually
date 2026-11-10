// Generate the site icons: the "F" of the home title on the footer's brown tile.
//
// Uses the same tools as generate-og-images.cjs (install them outside the project):
//   npm install sharp opentype.js @fontsource/eb-garamond
//   NODE_PATH=/that/folder/node_modules node scripts/generate-favicon.cjs
//
// Writes public/favicon.svg, public/favicon.ico (16, 32 and 48 px) and
// public/apple-touch-icon.png (180 px, square: iOS rounds the corners itself).
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const opentype = require('opentype.js');

const output = path.resolve(__dirname, '..', 'public');
const dir = path.dirname(require.resolve('@fontsource/eb-garamond/package.json'));
const fontBuffer = fs.readFileSync(path.join(dir, 'files', 'eb-garamond-latin-500-italic.woff'));
const font = opentype.parse(fontBuffer.buffer.slice(fontBuffer.byteOffset, fontBuffer.byteOffset + fontBuffer.byteLength));

const SIZE = 512;

// Path data written out by hand: opentype's own optimiser drops segments from some glyphs.
function pathData(glyphs) {
  const n = (value) => value.toFixed(2);
  return glyphs.commands.map((c) => {
    if (c.type === 'M' || c.type === 'L') return `${c.type}${n(c.x)} ${n(c.y)}`;
    if (c.type === 'C') return `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
    if (c.type === 'Q') return `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
    return 'Z';
  }).join('');
}

/** The letter F, scaled so its visible ink is `height` tall and centred in the tile. */
function letterF(height) {
  const probe = font.getPath('F', 0, 0, 100).getBoundingBox();
  const size = (100 * height) / (probe.y2 - probe.y1);
  const box = font.getPath('F', 0, 0, size).getBoundingBox();
  const x = SIZE / 2 - (box.x1 + box.x2) / 2;
  const y = SIZE / 2 - (box.y1 + box.y2) / 2;
  return pathData(font.getPath('F', x, y, size));
}

function icon({ rounded }) {
  const radius = rounded ? 104 : 0;
  const border = rounded ? 16 : 0;
  const f = letterF(rounded ? 318 : 290);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="wood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#542e1c"/><stop offset="1" stop-color="#3a1e12"/></linearGradient>
    <filter id="glowNear" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
    <filter id="glowFar" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="24"/></filter>
  </defs>
  <rect x="${border / 2}" y="${border / 2}" width="${SIZE - border}" height="${SIZE - border}" rx="${radius}" fill="url(#wood)"${border ? ` stroke="#4a2616" stroke-width="${border}"` : ''}/>
  ${rounded ? `<rect x="${border + 6}" y="${border + 6}" width="${SIZE - 2 * border - 12}" height="${SIZE - 2 * border - 12}" rx="${radius - border - 6}" fill="none" stroke="rgba(255,225,185,.22)" stroke-width="5"/>` : ''}
  <path d="${f}" fill="#ffd696" fill-opacity=".45" filter="url(#glowFar)"/>
  <path d="${f}" fill="#ffd696" fill-opacity=".8" filter="url(#glowNear)"/>
  <path d="${f}" fill="#fff0cf"/>
</svg>`;
}

/** An .ico file holding PNG images, which every current browser reads. */
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((png) => png.data)]);
}

(async () => {
  const rounded = icon({ rounded: true });
  fs.writeFileSync(path.join(output, 'favicon.svg'), rounded);
  const pngs = [];
  for (const size of [16, 32, 48]) {
    pngs.push({ size, data: await sharp(Buffer.from(rounded)).resize(size, size).png({ compressionLevel: 9 }).toBuffer() });
  }
  fs.writeFileSync(path.join(output, 'favicon.ico'), ico(pngs));
  await sharp(Buffer.from(icon({ rounded: false }))).resize(180, 180).png({ compressionLevel: 9 }).toFile(path.join(output, 'apple-touch-icon.png'));
  for (const file of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png']) {
    console.log(`${file}: ${(fs.statSync(path.join(output, file)).size / 1024).toFixed(1)} KB`);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
