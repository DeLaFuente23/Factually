import type { LegalBlock } from './legal';

/**
 * About and Contact copy, verbatim from the supplied final text. Blocks use the same
 * shape as the legal documents and are rendered by `LegalBody`: `**bold**`, `*italic*`
 * and `[label](url)`; links starting with `/` stay inside the site.
 */
export type InfoPage = { title: string; blocks: LegalBlock[] };

export const ABOUT: Record<'EN' | 'ES', InfoPage> = {
  EN: {
    title: 'About Factually...',
    blocks: [
      { p: 'Factually... is a daily game about the space between true and false.' },
      { p: 'Every day brings three rounds of three claims. In each round, one claim is **FACT.**, one is **KINDA?**, and one is **NOPE!** You have 60 seconds to work out which is which.' },
      { p: '**Why "KINDA?"** Because most misinformation isn\'t a pure lie. It\'s a real fact with the context cut off, a statistic stretched past what it shows, or a headline that\'s technically true and still misleading. Spotting obvious nonsense is easy. Spotting the half-truth is the real skill, and that\'s what Factually... is built to train, one quick game a day.' },
      { p: '**How the claims are made.** Every claim is researched before it goes live and comes with an explanation and a source, so after each game you can see why, and check our work. A verdict reflects our reading of the best evidence available when the claim was written. If you think we got one wrong, [tell us](/contact) and we\'ll review it.' },
      { p: '**Free, no account needed.** Just play. A new challenge arrives every day, and past challenges stay available in the [historical archive](/archive).' },
      { p: '**Who\'s behind it.** Factually... is an independent project made in Nicaragua by D_1901. Just for funsies.' },
      { p: '*Made for the curious & the occasionally certain.*' },
    ],
  },
  ES: {
    title: 'Acerca de Factually...',
    blocks: [
      { p: 'Factually... es un juego diario sobre el espacio entre lo verdadero y lo falso.' },
      { p: 'Cada día trae tres rondas de tres afirmaciones. En cada ronda, una es **FACTO.**, otra es **¿SUPONGO?** y otra es **¡NEL!** Tienes 60 segundos para descubrir cuál es cuál.' },
      { p: '**¿Por qué "¿SUPONGO?"?** Porque la mayoría de la desinformación no es una mentira pura. Es un dato real al que le cortaron el contexto, una estadística estirada más allá de lo que muestra, o un titular técnicamente cierto pero engañoso. Detectar un disparate obvio es fácil. Detectar la media verdad es la verdadera habilidad, y Factually... está hecho para entrenarla, una partida rápida al día.' },
      { p: '**Cómo se hacen las afirmaciones.** Cada afirmación se investiga antes de publicarse e incluye una explicación y una fuente, para que después de cada partida puedas ver el porqué y verificar nuestro trabajo. Un veredicto refleja nuestra lectura de la mejor evidencia disponible cuando se escribió la afirmación. Si crees que nos equivocamos, [escríbenos](/es/contacto) y lo revisaremos.' },
      { p: '**Gratis y sin cuenta.** Solo juega. Cada día llega un reto nuevo, y los anteriores siguen disponibles en el [archivo histórico](/es/archivo).' },
      { p: '**Quién está detrás.** Factually... es un proyecto independiente hecho en Nicaragua por D_1901. Por diversión.' },
      { p: '*Hecho para los curiosos y los ocasionalmente seguros.*' },
    ],
  },
};

export const CONTACT: Record<'EN' | 'ES', InfoPage> = {
  EN: {
    title: 'Contact',
    blocks: [
      { p: 'Factually... is a small independent project, so email is the best way to reach us: [**factuallygame@gmail.com**](mailto:factuallygame@gmail.com)' },
      { p: 'To help us answer quickly, please include:' },
      { ul: [
        '**Spotted an error in a claim?** The challenge date, the claim, what you think is wrong, and a source if you have one.',
        '**Privacy request?** Roughly when you played and what you\'d like reviewed or deleted. Please don\'t send passwords or other sensitive information. See our [Privacy Policy](/privacy) for details.',
        '**Something not working?** Your device, your browser, and what happened.',
        '**Have a claim to suggest?** Send it with a source. We can\'t promise to use every suggestion, but we read them all.',
        '**Anything else**, including feedback, press or partnerships, is welcome too.',
      ] },
      { p: 'We aim to reply within 5 days.' },
    ],
  },
  ES: {
    title: 'Contacto',
    blocks: [
      { p: 'Factually... es un proyecto independiente y pequeño, así que el correo es la mejor forma de contactarnos: [**factuallygame@gmail.com**](mailto:factuallygame@gmail.com)' },
      { p: 'Para responderte más rápido, incluye:' },
      { ul: [
        '**¿Encontraste un error en una afirmación?** La fecha del reto, la afirmación, qué crees que está mal y una fuente si la tienes.',
        '**¿Solicitud de privacidad?** Aproximadamente cuándo jugaste y qué te gustaría que revisemos o eliminemos. Por favor no envíes contraseñas ni otra información sensible. Consulta nuestra [Política de privacidad](/es/privacidad) para más detalles.',
        '**¿Algo no funciona?** Tu dispositivo, tu navegador y qué pasó.',
        '**¿Tienes una afirmación para sugerir?** Envíala con una fuente. No podemos prometer usar todas las sugerencias, pero las leemos todas.',
        '**Cualquier otra cosa**, incluidos comentarios, prensa o colaboraciones, también es bienvenida.',
      ] },
      { p: 'Intentamos responder en un plazo de 5 días.' },
    ],
  },
};
