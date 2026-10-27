import { describe, it, expect } from 'vitest';
import { parseRoute, routePath, otherLanguage } from './routes';
import type { Route } from './routes';
import { verdictLabel } from './verdicts';

const pairs: [string, string][] = [
  ['/', '/es'],
  ['/how-to-play', '/es/como-jugar'],
  ['/stats', '/es/estadisticas'],
  ['/archive', '/es/archivo'],
  ['/archive/2026-10-20/play', '/es/archivo/2026-10-20/jugar'],
  ['/archive/2026-10-20/sources', '/es/archivo/2026-10-20/fuentes'],
  ['/about', '/es/acerca-de'],
  ['/contact', '/es/contacto'],
  ['/privacy', '/es/privacidad'],
  ['/terms', '/es/terminos'],
  ['/play', '/es/jugar'],
];

describe('routes', () => {
  for (const [en, es] of pairs) {
    it(`maps ${en} <-> ${es}`, () => {
      expect(routePath(parseRoute(en))).toBe(en);
      expect(routePath(parseRoute(es))).toBe(es);
      expect(otherLanguage(parseRoute(en))).toBe(es);
      expect(otherLanguage(parseRoute(es))).toBe(en);
    });
  }

  it('reads the language from the path', () => {
    expect(parseRoute('/es/archivo/2026-10-20/fuentes')).toEqual<Route>({ name: 'sources', lang: 'ES', date: '2026-10-20' });
    expect(parseRoute('/about/')).toEqual<Route>({ name: 'about', lang: 'EN' });
  });

  it('does not mix languages or accept malformed dates', () => {
    expect(parseRoute('/es/about').name).toBe('notfound');
    expect(parseRoute('/archivo').name).toBe('notfound');
    expect(parseRoute('/archive/20-10-2026/sources').name).toBe('notfound');
  });
});

describe('verdict labels', () => {
  it('uses the new display names without touching stored values', () => {
    expect(['FACT', 'KINDA', 'BULLSHIT'].map((c) => verdictLabel(c as never, 'EN'))).toEqual(['FACT.', 'KINDA?', 'NOPE!']);
    expect(['FACT', 'KINDA', 'BULLSHIT'].map((c) => verdictLabel(c as never, 'ES'))).toEqual(['FACTO.', '¿SUPONGO?', '¡NEL!']);
  });
});
