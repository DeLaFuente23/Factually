import type { Category } from './game';
import type { Lang } from './routes';

/**
 * The one place verdict names are spelled for players. Storage, scoring, the Edge
 * Function and the database all keep the internal values (`FACT`, `KINDA`, `BULLSHIT`),
 * so renaming a label here never needs a migration and old games keep working.
 */
export const VERDICT_LABELS: Record<Category, Record<Lang, string>> = {
  FACT: { EN: 'FACT.', ES: 'FACTO.' },
  KINDA: { EN: 'KINDA?', ES: '¿SUPONGO?' },
  BULLSHIT: { EN: 'NOPE!', ES: '¡NEL!' },
};

export const verdictLabel = (category: Category, lang: Lang) => VERDICT_LABELS[category][lang];
