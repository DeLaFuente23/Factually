// Writes static HTML for every public page after `vite build`, so crawlers and no-JS
// visitors get real content: home, How to play, About, Contact, Privacy, Terms, the
// historical archive and the sources page of every finished day, in English and
// Spanish. Also writes sitemap.xml, robots.txt and the Cloudflare Pages _redirects.
//
// Archive data comes from the Edge Function's public `archive` action (publishable key
// only), which lists stored days strictly before today. Set PRERENDER_ARCHIVE_JSON to a
// file of the same shape ({ "YYYY-MM-DD": [[ids], [ids], [ids]] }) to build offline.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const root = process.cwd();
const dist = path.join(root, 'dist');
const SITE = 'https://factuallygame.fun';

// Local builds read .env the same way Vite does; Cloudflare provides real env vars.
for (const line of fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8').split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}

let today = new Date().toISOString().slice(0, 10);
async function loadArchive() {
  if (process.env.PRERENDER_ARCHIVE_JSON) return JSON.parse(fs.readFileSync(process.env.PRERENDER_ARCHIVE_JSON, 'utf8'));
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are required to prerender the archive.');
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase.functions.invoke('community', { body: { action: 'archive', challengeDate: today, challengeVersion: 'claims-v1' } });
  if (error || !data?.ok) throw new Error(`The archive could not be loaded from the Edge Function: ${data?.error || error?.message || 'unknown error'}`);
  // Use whichever clock is earlier, so a build machine running ahead can't publish today.
  if (data.today < today) today = data.today;
  return data.days;
}

const archive = Object.fromEntries(Object.entries(await loadArchive()).filter(([date]) => date < today));
const { render, prerenderRoutes, pageMeta } = await import(pathToFileURL(path.join(root, 'dist-ssr', 'entry-server.js')).href);

const templatePath = path.join(dist, 'index.html');
const template = fs.readFileSync(templatePath, 'utf8');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fileFor = (p) => (p === '/' ? 'index.html' : `${p.slice(1)}.html`);

function page(meta, lang, body, extraScript = '') {
  const head = [
    `<title>${esc(meta.title)}</title>`,
    `<meta name="description" content="${esc(meta.description)}">`,
    meta.noindex ? '<meta name="robots" content="noindex">' : '',
    `<link rel="canonical" href="${meta.canonical}">`,
    `<link rel="alternate" hreflang="en" href="${meta.en}">`,
    `<link rel="alternate" hreflang="es" href="${meta.es}">`,
    `<link rel="alternate" hreflang="x-default" href="${meta.en}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Factually...">`,
    `<meta property="og:title" content="${esc(meta.title)}">`,
    `<meta property="og:description" content="${esc(meta.description)}">`,
    `<meta property="og:url" content="${meta.canonical}">`,
    `<meta property="og:locale" content="${lang === 'ES' ? 'es_419' : 'en_US'}">`,
  ].filter(Boolean).join('');
  const html = template
    .replace(/<html lang="[^"]*">/, `<html lang="${lang === 'ES' ? 'es' : 'en'}">`)
    .replace(/<title>[^<]*<\/title>/, head)
    .replace('<div id="root"></div>', `<div id="root">${body}</div>${extraScript}`);
  if (html === template) throw new Error('index.html template did not match the expected markup.');
  return html;
}

function write(file, contents) {
  const out = path.join(dist, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, contents);
}

const routes = prerenderRoutes(archive, today);
const sitemap = [];
for (const route of routes) {
  const { html, meta } = render(routeUrl(route), archive);
  // A sources page carries its day's claim ids so the app's first render matches it.
  const data = route.name === 'sources' ? `<script>window.__FACTUALLY_DAYS__=${JSON.stringify({ [route.date]: archive[route.date] })}</script>` : '';
  write(fileFor(routeUrl(route)), page(meta, route.lang, html, data));
  if (route.lang === 'EN') sitemap.push(meta);
}

// Pages that are always rendered in the browser get a correct <head> but no content:
// today's statistics would spoil today's answers, and a game board is personal.
for (const lang of ['EN', 'ES']) {
  const stats = { name: 'stats', lang };
  write(fileFor(routeUrl(stats)), page(pageMeta(stats), lang, ''));
}
write('app.html', page(pageMeta({ name: 'play', lang: 'EN' }), 'EN', ''));
// Cloudflare Pages serves 404.html, with a 404 status, for any path without a file.
// It is the full app, so a route rendered in the browser (such as a day whose sources
// page has not been prerendered yet) still works; anything else shows the 404 page.
// A missing page has no canonical or language alternates of its own.
write('404.html', page(pageMeta({ name: 'notfound', lang: 'EN' }), 'EN', render('/404', archive).html)
  .replace(/<link rel="(canonical|alternate)"[^>]*>|<meta property="og:url"[^>]*>/g, ''));
write('_redirects', [
  // Rewrite to the extensionless path: Pages answers /app.html itself with a redirect to /app.
  '# Play routes are rendered in the browser from a noindex shell.',
  '/play /app 200',
  '/es/jugar /app 200',
  '/archive/:date/play /app 200',
  '/es/archivo/:date/jugar /app 200',
  '',
].join('\n'));

write('sitemap.xml', [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
  ...sitemap.flatMap((m) => [m.en, m.es].map((loc) => `<url><loc>${loc}</loc><xhtml:link rel="alternate" hreflang="en" href="${m.en}"/><xhtml:link rel="alternate" hreflang="es" href="${m.es}"/><xhtml:link rel="alternate" hreflang="x-default" href="${m.en}"/></url>`)),
  '</urlset>',
  '',
].join('\n'));
write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`Prerendered ${routes.length} pages (${Object.keys(archive).length} archive days before ${today}).`);

function routeUrl(route) {
  return new URL(pageMeta(route).canonical).pathname;
}
