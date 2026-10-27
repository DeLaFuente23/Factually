/**
 * Public URLs. Every page has an English path and a Spanish path under `/es`, and the
 * language toggle maps one to the other with `routePath({...route, lang})`.
 *
 * Today's game lives at `/play` (`/es/jugar`); a past day is played at
 * `/archive/YYYY-MM-DD/play` and reviewed at `/archive/YYYY-MM-DD/sources`.
 */
export type Lang = 'EN' | 'ES';
export type RouteName = 'home' | 'rules' | 'stats' | 'archive' | 'play' | 'sources' | 'about' | 'contact' | 'privacy' | 'terms' | 'notfound';
export type Route = { name: RouteName; lang: Lang; date?: string };

const PAGES: Partial<Record<RouteName, [string, string]>> = {
  rules: ['how-to-play', 'como-jugar'],
  stats: ['stats', 'estadisticas'],
  archive: ['archive', 'archivo'],
  play: ['play', 'jugar'],
  about: ['about', 'acerca-de'],
  contact: ['contact', 'contacto'],
  privacy: ['privacy', 'privacidad'],
  terms: ['terms', 'terminos'],
};
const SOURCES: [string, string] = ['sources', 'fuentes'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseRoute(pathname: string): Route {
  const parts = pathname.replace(/\.html$/, '').split('/').filter(Boolean).map((p) => decodeURIComponent(p).toLowerCase());
  const lang: Lang = parts[0] === 'es' ? 'ES' : 'EN';
  if (lang === 'ES') parts.shift();
  const i = lang === 'ES' ? 1 : 0;
  if (parts.length === 0) return { name: 'home', lang };
  if (parts.length === 1) {
    for (const [name, slugs] of Object.entries(PAGES)) if (slugs![i] === parts[0]) return { name: name as RouteName, lang };
  }
  if (parts.length === 3 && parts[0] === PAGES.archive![i] && DATE.test(parts[1])) {
    if (parts[2] === PAGES.play![i]) return { name: 'play', lang, date: parts[1] };
    if (parts[2] === SOURCES[i]) return { name: 'sources', lang, date: parts[1] };
  }
  return { name: 'notfound', lang };
}

export function routePath(route: Route): string {
  const i = route.lang === 'ES' ? 1 : 0;
  const prefix = route.lang === 'ES' ? '/es' : '';
  if (route.name === 'home' || route.name === 'notfound') return prefix || '/';
  if (route.date && (route.name === 'play' || route.name === 'sources')) {
    return `${prefix}/${PAGES.archive![i]}/${route.date}/${route.name === 'play' ? PAGES.play![i] : SOURCES[i]}`;
  }
  return `${prefix}/${PAGES[route.name]![i]}`;
}

/** The same page in the other language. */
export const otherLanguage = (route: Route): string => routePath({ ...route, lang: route.lang === 'EN' ? 'ES' : 'EN' });
