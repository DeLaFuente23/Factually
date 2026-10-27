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
      { h: 'How the claims are made.' },
      { p: 'Every claim is researched before it goes live and comes with an explanation and a source, so after each game you can see why, and check our work. A verdict reflects our reading of the best evidence available when the claim was written. If you think we got one wrong, [tell us](/contact) and we\'ll review it.' },
      { h: 'Free, no account needed.' },
      { p: 'Just play. A new challenge arrives every day, and past challenges stay available in the [historical archive](/archive).' },
      { h: 'Who\'s behind it.' },
      { p: 'Factually... is an independent project made in Nicaragua by D_1901. Just for funsies.' },
      { p: '*Bring a gas can with you when the car dies on the side of the road.*' },
    ],
  },
  ES: {
    title: 'Acerca de Factually...',
    blocks: [
      { p: 'Factually... es un juego diario sobre el espacio entre lo verdadero y lo falso.' },
      { p: 'Cada día trae tres rondas de tres afirmaciones. En cada ronda, una es **FACTO.**, otra es **¿SUPONGO?** y otra es **¡NEL!** Tienes 60 segundos para descubrir cuál es cuál.' },
      { h: 'Cómo se hacen las afirmaciones.' },
      { p: 'Cada afirmación se investiga antes de publicarse e incluye una explicación y una fuente, para que después de cada partida puedas ver el porqué y verificar nuestro trabajo. Un veredicto refleja nuestra lectura de la mejor evidencia disponible cuando se escribió la afirmación. Si crees que nos equivocamos, [escríbenos](/es/contacto) y lo revisaremos.' },
      { h: 'Gratis y sin cuenta.' },
      { p: 'Solo juega. Cada día llega un reto nuevo, y los anteriores siguen disponibles en el [archivo histórico](/es/archivo).' },
      { h: 'Quién está detrás.' },
      { p: 'Factually... es un proyecto independiente hecho en Nicaragua por D_1901. Por diversión.' },
      { p: '*Lleva un galón de gasolina contigo por si el carro se te muere a la orilla de la carretera.*' },
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
      { p: 'We aim to reply within 5 days or less.' },
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
      { p: 'Intentamos responder en un plazo de 5 días o menos.' },
    ],
  },
};
