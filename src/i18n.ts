import type { WildcardName } from './game';

export type Lang = 'en' | 'es';

/** localStorage key that remembers the player's chosen language on this device. */
export const LANG_KEY = 'factually.lang';

const en = {
  // header
  menu: '← Menu',
  toSpanish: 'Switch to Spanish',
  toEnglish: 'Switch to English',
  // home
  tagline: 'You know these things (probably).',
  playToday: 'Play today’s game',
  checkResults: 'Check today’s results',
  howToPlay: 'How to play',
  seeLeaderboard: 'See leaderboard',
  checkArchive: 'Check archive',
  // game header
  dailyChallenge: 'DAILY CHALLENGE',
  roundOf: (n: string) => `ROUND ${n} OF 3`,
  score: 'SCORE',
  secondsRemaining: (n: number) => `${n} seconds remaining`,
  // claim card
  claimNo: (n: string) => `CLAIM No. ${n}`,
  sheetAria: (n: number) => `Claim ${n}`,
  claimAria: (n: number, which: string) => `Claim ${n}, ${which}`,
  fullContext: 'full context',
  scoreSummary: 'score summary',
  oneOffBadge: (truth: string) => `ONE OFF · ${truth}`,
  lifesaverProtection: '✦ LIFESAVER PROTECTION',
  correct: 'CORRECT',
  incorrect: 'INCORRECT',
  partial: 'PARTIALLY CORRECT',
  earnedPoints: (pts: string, one: boolean) => `+${pts} ${one ? 'point' : 'points'}`,
  tapForContext: 'Click this card to get the full context.',
  tapToFlipBack: 'Tap this card again to flip it back.',
  chooseClaim: 'Choose this claim',
  choose: 'Choose',
  // wildcards
  wildcardsUnused: (n: number) => `WILDCARDS · ${n} UNUSED`,
  usedSuffix: ' · USED',
  back: '← Back',
  // notices
  wildSpent: 'That wildcard has already been spent.',
  wildCancelled: 'Wildcard selection cancelled.',
  selectClaim: (tip: string) => `Select a claim to use it. ${tip}`,
  alreadyRevealed: 'That claim is already revealed.',
  verdictRevealed: 'Verdict revealed and locked.',
  lifesaverProtects: 'Lifesaver protects this claim.',
  noReplacement: 'No replacement is available; Swap remains unused.',
  newClaimDealt: 'A new claim from the same hidden category is dealt.',
  assignAll: 'Assign all three verdicts before locking in.',
  timeUp: 'Time is up. Unanswered claims score zero.',
  answersLocked: 'Answers locked.',
  // buttons
  lockIn: 'Lock in answers',
  continueRound: 'Continue to next round →',
  checkResultsBtn: 'Check results',
  // final screen
  thatsAll: 'THAT’S ALL, FOLKS!',
  finalVerdict: 'Your final verdict',
  shareScore: 'Share your score',
  readyToShare: 'Ready to share.',
  copied: 'Score copied to clipboard.',
  selectCopy: 'Select and copy your score below.',
  shareTitle: 'My Factually... score',
  shareText: (score: string, grid: string, hearts: string, origin: string) =>
    `Factually... 🤓\nI scored ${score}/10! Think you can beat me?\n\n${grid}\n${hearts}\n\n${origin}`,
  scoreShareAria: 'Score sharing message',
  roundReview: 'Round review',
  roundLabel: (n: number, pts: string) => `Round ${n} · ${pts} points`,
  yourAnswer: 'Your answer:',
  correctLabel: 'Correct:',
  noAnswer: 'No answer',
  wildcardsPoints: (pts: string) => `Wildcards · ${pts} points`,
  usedOnRound: (r: number) => `You used this wildcard on Round ${r}: `,
  notUsedWild: "You didn't use this wildcard on today's game.",
  // archive
  backCatalogue: 'THE BACK CATALOGUE',
  dailyArchive: 'Daily archive',
  archiveBlurb: 'Challenges use a deterministic local date. Previous dates can be played or reviewed.',
  reviewResult: 'Review result',
  playChallenge: 'Play challenge',
  // leaderboard
  privateParlour: 'YOUR PRIVATE PARLOR',
  personalLeaderboard: 'Personal leaderboard',
  leaderboardBlurb: 'Stored only in this browser. These are not global rankings and do not sync across devices.',
  noScores: 'No scores on the board yet.',
  finishGame: 'Finish a daily game and your result will appear here.',
  // rules
  houseRules: 'HOUSE RULES',
  howToPlayHeading: 'How to play',
  rulesIntro: 'Three rounds, three claims each. Every round has one FACT!, one KINDA?, and one BULLSH1T. Assign each verdict once.',
  rulesFact: 'The claim is accurate as written and understandable without a material missing caveat.',
  rulesKinda: 'The claim has a factual basis, but an important caveat, ambiguity, missing context, or misleading framing changes how it should be interpreted.',
  rulesBull: "The claim's central assertion is false, fabricated, or contradicted by reliable evidence.",
  scoringHeading: 'Scoring',
  scoring1: 'Correct is 1 point.',
  scoring2: 'FACT!/KINDA? neighbors earn 0.5 point per claim.',
  scoring3: 'KINDA?/BULLSH1T neighbors earn 0.33.',
  scoring4: 'FACT!/BULLSH1T earns zero.',
  scoringExample: 'Example: one FACT!/KINDA? mismatch and two correct earns 2.5 points.',
  wildcardsHeading: 'Wildcards',
  rulesOneOff: 'reveals and locks a verdict.',
  rulesSwap: 'replaces a claim from the same category.',
  rulesLifesaver: 'protects a claim and its counterpart from a scoring mistake.',
  rulesSaved: 'Each is available once; each saved wildcard adds 0.33 point. So you can accumulate 1 saved-wildcard point + 9 perfect classification points = 10 points in total.',
  // footer
  footerTagline: 'MADE FOR THE CURIOUS & THE OCCASIONALLY CERTAIN',
  footerCredit: 'Powered by ADHD ↗',
};

export type Strings = typeof en;

const es: Strings = {
  // header
  menu: '← Menú',
  toSpanish: 'Cambiar a español',
  toEnglish: 'Switch to English',
  // home
  tagline: 'Sabes estas cosas (probablemente).',
  playToday: 'Juega el reto de hoy',
  checkResults: 'Mira los resultados de hoy',
  howToPlay: 'Cómo jugar',
  seeLeaderboard: 'Ver la tabla',
  checkArchive: 'Ver el archivo',
  // game header
  dailyChallenge: 'RETO DIARIO',
  roundOf: (n: string) => `RONDA ${n} DE 3`,
  score: 'PUNTOS',
  secondsRemaining: (n: number) => `${n} segundos restantes`,
  // claim card
  claimNo: (n: string) => `AFIRMACIÓN N.º ${n}`,
  sheetAria: (n: number) => `Afirmación ${n}`,
  claimAria: (n: number, which: string) => `Afirmación ${n}, ${which}`,
  fullContext: 'contexto completo',
  scoreSummary: 'resumen de puntos',
  oneOffBadge: (truth: string) => `UNO FUERA · ${truth}`,
  lifesaverProtection: '✦ PROTECCIÓN SALVAVIDAS',
  correct: 'CORRECTO',
  incorrect: 'INCORRECTO',
  partial: 'PARCIALMENTE CORRECTO',
  earnedPoints: (pts: string, one: boolean) => `+${pts} ${one ? 'punto' : 'puntos'}`,
  tapForContext: 'Toca esta tarjeta para ver todo el contexto.',
  tapToFlipBack: 'Toca esta tarjeta otra vez para volver.',
  chooseClaim: 'Elegir esta afirmación',
  choose: 'Elegir',
  // wildcards
  wildcardsUnused: (n: number) => `COMODINES · ${n} SIN USAR`,
  usedSuffix: ' · USADO',
  back: '← Atrás',
  // notices
  wildSpent: 'Ese comodín ya se usó.',
  wildCancelled: 'Selección de comodín cancelada.',
  selectClaim: (tip: string) => `Selecciona una afirmación para usarlo. ${tip}`,
  alreadyRevealed: 'Esa afirmación ya está revelada.',
  verdictRevealed: 'Veredicto revelado y bloqueado.',
  lifesaverProtects: 'Salvavidas protege esta afirmación.',
  noReplacement: 'No hay reemplazo disponible; Cambio sigue sin usarse.',
  newClaimDealt: 'Se reparte una nueva afirmación de la misma categoría oculta.',
  assignAll: 'Asigna los tres veredictos antes de bloquear.',
  timeUp: 'Se acabó el tiempo. Las afirmaciones sin responder suman cero.',
  answersLocked: 'Respuestas bloqueadas.',
  // buttons
  lockIn: 'Bloquear respuestas',
  continueRound: 'Continuar a la siguiente ronda →',
  checkResultsBtn: 'Ver resultados',
  // final screen
  thatsAll: '¡ESO ES TODO, AMIGOS!',
  finalVerdict: 'Tu veredicto final',
  shareScore: 'Comparte tu puntuación',
  readyToShare: 'Listo para compartir.',
  copied: 'Puntuación copiada al portapapeles.',
  selectCopy: 'Selecciona y copia tu puntuación abajo.',
  shareTitle: 'Mi puntuación en Factually...',
  shareText: (score: string, grid: string, hearts: string, origin: string) =>
    `Factually... 🤓\n¡Saqué ${score}/10! ¿Crees que puedes superarme?\n\n${grid}\n${hearts}\n\n${origin}`,
  scoreShareAria: 'Mensaje para compartir la puntuación',
  roundReview: 'Revisión de rondas',
  roundLabel: (n: number, pts: string) => `Ronda ${n} · ${pts} puntos`,
  yourAnswer: 'Tu respuesta:',
  correctLabel: 'Correcta:',
  noAnswer: 'Sin respuesta',
  wildcardsPoints: (pts: string) => `Comodines · ${pts} puntos`,
  usedOnRound: (r: number) => `Usaste este comodín en la Ronda ${r}: `,
  notUsedWild: 'No usaste este comodín en la partida de hoy.',
  // archive
  backCatalogue: 'EL CATÁLOGO',
  dailyArchive: 'Archivo diario',
  archiveBlurb: 'Los retos usan una fecha local determinista. Puedes jugar o revisar fechas anteriores.',
  reviewResult: 'Revisar resultado',
  playChallenge: 'Jugar reto',
  // leaderboard
  privateParlour: 'TU SALÓN PRIVADO',
  personalLeaderboard: 'Tabla personal',
  leaderboardBlurb: 'Se guarda solo en este navegador. No son clasificaciones globales y no se sincronizan entre dispositivos.',
  noScores: 'Aún no hay puntuaciones en la tabla.',
  finishGame: 'Termina una partida diaria y tu resultado aparecerá aquí.',
  // rules
  houseRules: 'REGLAS DE LA CASA',
  howToPlayHeading: 'Cómo jugar',
  rulesIntro: 'Tres rondas, tres afirmaciones cada una. Cada ronda tiene un FACT!, un KINDA? y un BULLSH1T. Asigna cada veredicto una sola vez.',
  rulesFact: 'La afirmación es exacta tal como está escrita y se entiende sin una salvedad importante que falte.',
  rulesKinda: 'La afirmación tiene una base real, pero una salvedad importante, ambigüedad, falta de contexto o un encuadre engañoso cambia cómo debe interpretarse.',
  rulesBull: 'La afirmación central es falsa, inventada o contradicha por evidencia confiable.',
  scoringHeading: 'Puntuación',
  scoring1: 'Una correcta suma 1 punto.',
  scoring2: 'Los vecinos FACT!/KINDA? suman 0.5 punto por afirmación.',
  scoring3: 'Los vecinos KINDA?/BULLSH1T suman 0.33.',
  scoring4: 'FACT!/BULLSH1T suma cero.',
  scoringExample: 'Ejemplo: un fallo FACT!/KINDA? y dos correctas suman 2.5 puntos.',
  wildcardsHeading: 'Comodines',
  rulesOneOff: 'revela y bloquea un veredicto.',
  rulesSwap: 'reemplaza una afirmación de la misma categoría.',
  rulesLifesaver: 'protege una afirmación y su contraparte de un error de puntuación.',
  rulesSaved: 'Cada uno está disponible una vez; cada comodín guardado suma 0.33 punto. Así puedes acumular 1 punto por comodín guardado + 9 puntos por clasificación perfecta = 10 puntos en total.',
  // footer
  footerTagline: 'HECHO PARA LOS CURIOSOS Y LOS OCASIONALMENTE SEGUROS',
  footerCredit: 'Creado por ADHD ↗',
};

export const STRINGS: Record<Lang, Strings> = { en, es };

/** Display names for wildcards. Internal keys/state stay English. */
export const WILD_NAME: Record<Lang, Record<WildcardName, string>> = {
  en: { 'One Off': 'One Off', Swap: 'Swap', Lifesaver: 'Lifesaver' },
  es: { 'One Off': 'Uno Fuera', Swap: 'Cambio', Lifesaver: 'Salvavidas' },
};

/** Hover/aria tips for each wildcard. */
export const TIPS: Record<Lang, Record<WildcardName, string>> = {
  en: {
    'One Off': 'Reveal and lock the true category of one claim.',
    Swap: 'Replace a claim with a new one from the same hidden category.',
    Lifesaver: 'Protect this claim and its counterpart from a scoring mistake.',
  },
  es: {
    'One Off': 'Revela y bloquea la categoría real de una afirmación.',
    Swap: 'Reemplaza una afirmación por otra nueva de la misma categoría oculta.',
    Lifesaver: 'Protege esta afirmación y su contraparte de un error de puntuación.',
  },
};

/** Localised long date. Kept UTC so the label matches the deterministic day key. */
export function dateName(lang: Lang, d: string): string {
  return new Date(d + 'T12:00:00Z').toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
