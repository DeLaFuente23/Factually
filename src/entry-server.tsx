import React from 'react';
import { renderToString } from 'react-dom/server';
import { App, archiveDates } from './App';
import type { ArchiveDays } from './App';
import { pageMeta } from './seo';
import { parseRoute, routePath } from './routes';
import type { Lang, Route } from './routes';

/** Build-time entry used by `scripts/prerender.mjs`. Never shipped to the browser. */
export function render(path: string, archive: ArchiveDays) {
  const route = parseRoute(path);
  return { html: renderToString(<App initialPath={path} archive={archive} />), meta: pageMeta(route), route };
}

/**
 * Every page to prerender. `archive` must only hold days before today: it comes from
 * the Edge Function's `archive` action, which refuses today and later, and is filtered
 * again here so today's answers can never reach a static page.
 */
export function prerenderRoutes(archive: ArchiveDays, today: string): Route[] {
  const langs: Lang[] = ['EN', 'ES'];
  const pages: Route['name'][] = ['home', 'rules', 'archive', 'about', 'contact', 'privacy', 'terms'];
  const days = Object.keys(archive).filter((d) => d < today && archiveDates(today).includes(d)).sort().reverse();
  return langs.flatMap((lang) => [
    ...pages.map((name) => ({ name, lang })),
    ...days.map((date) => ({ name: 'sources' as const, lang, date })),
  ]);
}

export { pageMeta, routePath };
