// Generate the two social preview images in the site's library style.
//
// The image tools are deliberately not project dependencies. Install them in a folder of
// your choice and point NODE_PATH at its node_modules:
//   npm install sharp opentype.js @fontsource/alegreya @fontsource/eb-garamond
//   NODE_PATH=/that/folder/node_modules node scripts/generate-og-images.cjs
//
// Text is drawn as vector paths, so the result does not depend on installed system fonts,
// and each line is centred on its visible letters.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const opentype = require('opentype.js');

const WIDTH = 1200;
const HEIGHT = 630;
const repo = path.resolve(__dirname, '..');
const output = path.join(repo, 'public');
const background = path.join(repo, 'src', 'assets', 'library-bg.webp');

function loadFont(pkg, file) {
  const dir = path.dirname(require.resolve(`${pkg}/package.json`));
  const buffer = fs.readFileSync(path.join(dir, 'files', file));
  return opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

const titleFont = loadFont('@fontsource/eb-garamond', 'eb-garamond-latin-500-italic.woff');
const taglineFont = loadFont('@fontsource/eb-garamond', 'eb-garamond-latin-400-italic.woff');
const labelFont = loadFont('@fontsource/alegreya', 'alegreya-latin-800-normal.woff');

/** SVG path data for an opentype path. Written out here because the library's own
    toPathData optimiser drops segments from some glyphs. */
function pathData(glyphs) {
  const n = (value) => value.toFixed(2);
  return glyphs.commands.map((c) => {
    if (c.type === 'M' || c.type === 'L') return `${c.type}${n(c.x)} ${n(c.y)}`;
    if (c.type === 'C') return `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
    if (c.type === 'Q') return `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
    return 'Z';
  }).join('');
}

/** SVG path data for `text`, with its visible letters centred horizontally on `centerX`. */
function centeredPath(font, text, centerX, baseline, size, letterSpacing = 0) {
  const options = { letterSpacing, kerning: true };
  const box = font.getPath(text, 0, baseline, size, options).getBoundingBox();
  const x = centerX - (box.x1 + box.x2) / 2;
  return pathData(font.getPath(text, x, baseline, size, options));
}

const VERDICTS = [
  { top: '#50b43a', bottom: '#37912c', edge: '#1f6130', ink: '#ffffff', shadow: 'rgba(10,50,15,.8)' },
  { top: '#fbc64c', bottom: '#efa92f', edge: '#b67d2b', ink: '#4a2110', shadow: null },
  { top: '#d04a34', bottom: '#b43423', edge: '#79211a', ink: '#ffffff', shadow: 'rgba(80,15,8,.8)' },
];

function verdictButton(label, index) {
  const style = VERDICTS[index];
  const x = 96 + index * 350;
  const y = 408;
  const width = 308;
  const height = 116;
  const text = centeredPath(labelFont, label, x + width / 2, y + 75, 50);
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="15" fill="url(#verdict${index})" stroke="${style.edge}" stroke-width="4" filter="url(#lift)"/>
  <rect x="${x + 4}" y="${y + 4}" width="${width - 8}" height="${height - 8}" rx="11" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="2"/>
  ${style.shadow ? `<path d="${text}" fill="${style.shadow}" transform="translate(0 2)"/>` : ''}
  <path d="${text}" fill="${style.ink}"/>`;
}

function overlay({ tagline, labels }) {
  const title = centeredPath(titleFont, 'Factually...', WIDTH / 2, 248, 158, -0.04);
  const subtitle = centeredPath(taglineFont, tagline, WIDTH / 2, 330, 42);
  const gradients = VERDICTS.map((style, index) => `<linearGradient id="verdict${index}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${style.top}"/><stop offset="1" stop-color="${style.bottom}"/></linearGradient>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <radialGradient id="shade" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#541408" stop-opacity=".5"/><stop offset="1" stop-color="#260904" stop-opacity=".78"/></radialGradient>
    <filter id="glowNear" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="5"/></filter>
    <filter id="glowFar" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="14"/></filter>
    <filter id="lift" x="-10%" y="-20%" width="120%" height="150%"><feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#000" flood-opacity=".55"/></filter>
    ${gradients}
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#shade)"/>
  <path d="${title}" fill="#ffd696" fill-opacity=".45" filter="url(#glowFar)"/>
  <path d="${title}" fill="#ffd696" fill-opacity=".85" filter="url(#glowNear)"/>
  <path d="${title}" fill="#fff0cf"/>
  <path d="${subtitle}" fill="#fff0cf"/>
  ${labels.map(verdictButton).join('\n  ')}
</svg>`;
}

const images = [
  { file: 'og-image.png', tagline: 'You know these things (probably).', labels: ['FACT.', 'KINDA?', 'NOPE!'] },
  { file: 'og-image-es.png', tagline: 'Tú sabes estas cosas (probablemente).', labels: ['FACTO.', '¿SUPONGO?', '¡NEL!'] },
];

(async () => {
  fs.mkdirSync(output, { recursive: true });
  for (const image of images) {
    const target = path.join(output, image.file);
    const buffer = await sharp(background)
      .resize(WIDTH, HEIGHT, { fit: 'cover' })
      .composite([{ input: Buffer.from(overlay(image)) }])
      .png({ palette: true, colors: 256, quality: 92, dither: 0.6, compressionLevel: 9 })
      .toBuffer();
    if (buffer.length >= 300 * 1024) throw new Error(`${image.file} is ${buffer.length} bytes; expected under 300 KB.`);
    fs.writeFileSync(target, buffer);
    console.log(`${image.file}: ${WIDTH}x${HEIGHT}, ${(buffer.length / 1024).toFixed(1)} KB`);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
