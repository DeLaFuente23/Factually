import type { Route } from './routes';
import { routePath } from './routes';

export const SITE = 'https://factuallygame.fun';

export type PageMeta = { title: string; description: string; canonical: string; en: string; es: string; noindex: boolean };

const longDate = (date: string, es: boolean) =>
  new Date(date + 'T12:00:00Z').toLocaleDateString(es ? 'es-GT' : 'en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/**
 * Title, description and alternate URLs for a route. Shared by the build-time
 * prerender (which writes them into each page's <head>) and the client router (which
 * keeps the title in step while navigating).
 */
export function pageMeta(route: Route): PageMeta {
  const es = route.lang === 'ES';
  const t = (en: string, esText: string) => (es ? esText : en);
  const brand = 'Factually...';
  let title = brand, description = '';
  switch (route.name) {
    case 'home':
      title = t('Factually... | A daily game about true, false and in between', 'Factually... | Un juego diario sobre lo verdadero, lo falso y lo de en medio');
      description = t('Three rounds, three claims each: one FACT., one KINDA? and one NOPE! Sort them in 60 seconds, then check the explanation and source behind every verdict.', 'Tres rondas de tres afirmaciones: una es FACTO., otra ¿SUPONGO? y otra ¡NEL! Clasifícalas en 60 segundos y revisa la explicación y la fuente de cada veredicto.');
      break;
    case 'rules':
      title = t(`How to play · ${brand}`, `Cómo jugar · ${brand}`);
      description = t('The rules of Factually...: verdicts, scoring and the three wildcards.', 'Las reglas de Factually...: veredictos, puntuación y los tres comodines.');
      break;
    case 'stats':
      title = t(`Statistics · ${brand}`, `Estadísticas · ${brand}`);
      description = t('How everyone is doing on today’s Factually... challenge.', 'Cómo le va a todo el mundo en el reto de hoy de Factually...');
      break;
    case 'archive':
      title = t(`Historical archive · ${brand}`, `Archivo histórico · ${brand}`);
      description = t('Every past Factually... challenge: play the ones you missed or check the verdicts, explanations and sources.', 'Todos los retos anteriores de Factually...: juega los que te perdiste o revisa los veredictos, explicaciones y fuentes.');
      break;
    case 'sources':
      title = t(`Sources for ${longDate(route.date!, false)} · ${brand}`, `Fuentes del ${longDate(route.date!, true)} · ${brand}`);
      description = t(`The nine claims from the ${longDate(route.date!, false)} challenge, with each verdict, explanation and source.`, `Las nueve afirmaciones del reto del ${longDate(route.date!, true)}, con su veredicto, explicación y fuente.`);
      break;
    case 'play':
      title = t(`Daily challenge · ${brand}`, `Reto diario · ${brand}`);
      description = t('Play the Factually... daily challenge.', 'Juega el reto diario de Factually...');
      break;
    case 'about':
      title = t(`About · ${brand}`, `Acerca de · ${brand}`);
      description = t('Factually... is a free daily game about the space between true and false, made in Nicaragua.', 'Factually... es un juego diario y gratuito sobre el espacio entre lo verdadero y lo falso, hecho en Nicaragua.');
      break;
    case 'contact':
      title = t(`Contact · ${brand}`, `Contacto · ${brand}`);
      description = t('How to reach Factually...: report an error in a claim, make a privacy request or suggest a claim.', 'Cómo contactar a Factually...: reporta un error en una afirmación, haz una solicitud de privacidad o sugiere una afirmación.');
      break;
    case 'privacy':
      title = t(`Privacy Policy · ${brand}`, `Política de Privacidad · ${brand}`);
      description = t('What Factually... stores, why, and the choices you have.', 'Qué almacena Factually..., por qué y qué opciones tienes.');
      break;
    case 'terms':
      title = t(`Terms of Service · ${brand}`, `Términos de Servicio · ${brand}`);
      description = t('The terms for playing Factually...', 'Los términos para jugar Factually...');
      break;
    default:
      title = t(`Page not found · ${brand}`, `Página no encontrada · ${brand}`);
      description = t('Like the legend that 404 is a room at CERN, this page isn’t real.', 'Igual que la leyenda de que el 404 es una sala del CERN, esta página no es real.');
  }
  const en = SITE + routePath({ ...route, lang: 'EN' });
  const esUrl = SITE + routePath({ ...route, lang: 'ES' });
  return {
    title, description,
    canonical: es ? esUrl : en, en, es: esUrl,
    // Play routes and today's statistics are personal or spoil today's answers.
    noindex: route.name === 'play' || route.name === 'stats' || route.name === 'notfound',
  };
}
