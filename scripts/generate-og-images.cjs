// Generate the two social preview images in the site's existing visual style.
// Requires ImageMagick (`magick`) on PATH. Run: node scripts/generate-og-images.cjs
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.resolve(__dirname, '..', 'public');
fs.mkdirSync(root, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'factually-og-'));

function esc(text) {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}

function template({ tagline, labels }) {
  const colors = ['#9ed7c2', '#e8d18a', '#d99e8b'];
  const cards = labels.map((label, index) => {
    const x = 108 + index * 342;
    return `<g>
      <rect x="${x}" y="414" width="300" height="112" fill="#102e42" stroke="#c9b994" stroke-width="2"/>
      <rect x="${x + 8}" y="422" width="284" height="96" fill="none" stroke="#766f5d" stroke-width="1"/>
      <text x="${x + 150}" y="483" text-anchor="middle" fill="${colors[index]}" font-family="Garamond, Georgia, serif" font-size="38" font-weight="600" letter-spacing="2">${esc(label)}</text>
    </g>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="bg" cx="50%" cy="12%" r="90%"><stop offset="0" stop-color="#1b3850"/><stop offset="1" stop-color="#10243a"/></radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="42" y="42" width="1116" height="546" fill="none" stroke="#a99a75" stroke-width="2"/>
  <rect x="50" y="50" width="1100" height="530" fill="none" stroke="#746b54" stroke-width="1"/>
  <text x="600" y="250" text-anchor="middle" fill="#eadfc9" font-family="Garamond, Georgia, serif" font-size="126" font-style="italic" font-weight="500" letter-spacing="-4">Factually...</text>
  <text x="600" y="320" text-anchor="middle" fill="#e0d4bf" font-family="Garamond, Georgia, serif" font-size="34" font-style="italic">${esc(tagline)}</text>
  ${cards}
</svg>`;
}

const images = [
  {
    file: 'og-image.png',
    tagline: 'You know these things (probably).',
    labels: ['FACT.', 'KINDA?', 'NOPE!'],
  },
  {
    file: 'og-image-es.png',
    tagline: 'Tú sabes estas cosas (probablemente).',
    labels: ['FACTO.', '¿SUPONGO?', '¡NEL!'],
  },
];

try {
  for (const image of images) {
    const svg = path.join(temp, `${image.file}.svg`);
    fs.writeFileSync(svg, template(image), 'utf8');
    execFileSync('magick', [svg, '-strip', '-define', 'png:compression-level=9', path.join(root, image.file)], { stdio: 'inherit' });
    const stat = fs.statSync(path.join(root, image.file));
    if (stat.size >= 300 * 1024) throw new Error(`${image.file} is ${stat.size} bytes; expected under 300 KB.`);
    console.log(`${image.file}: 1200x630, ${(stat.size / 1024).toFixed(1)} KB`);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
