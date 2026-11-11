/**
 * Game sounds, synthesised with Web Audio in an 8-bit (chiptune) style, so there
 * are no files to load.
 *
 * Everything lives in C major so any sequence of results sounds consonant:
 * - round reveal: one note, higher is better (C5 / G4 / E4 / C4)
 * - final verdict: two notes that always land on C; up is good, down is not,
 *   starting on G marks the extremes and starting on E the middle
 * - wildcard: a bright A5, outside the chord so it reads as special
 * - button clicks: a short square-wave blip
 *
 * Notes are pulse waves (the classic console lead) that sustain, then fade
 * through a short echo, with a little vibrato on the held ones, so they ring
 * out instead of stopping dead. Final notes add a triangle-wave bass an octave
 * down, like a console's bass channel.
 */

export type Tier = 1 | 2 | 3 | 4;

const NOTE = { C4: 261.63, E4: 329.63, G4: 392.0, C5: 523.25, E5: 659.25, G5: 783.99, A5: 880.0, C6: 1046.5 };

const ROUND_NOTE: Record<Tier, number> = { 4: NOTE.C5, 3: NOTE.G4, 2: NOTE.E4, 1: NOTE.C4 };
const FINAL_NOTES: Record<Tier, [number, number]> = {
  4: [NOTE.G4, NOTE.C5],
  3: [NOTE.E4, NOTE.C5],
  2: [NOTE.E4, NOTE.C4],
  1: [NOTE.G4, NOTE.C4],
};

/**
 * Sorts a score into four bands by the share of points earned. Per round
 * (out of 18): 15+ excellent (two correct and a partially correct, or better),
 * 11+ good, 6+ mixed, below that rough. The final verdict uses the same shares.
 */
export function tierFor(points: number, max: number): Tier {
  const share = max > 0 ? points / max : 0;
  return share >= 15 / 18 ? 4 : share >= 11 / 18 ? 3 : share >= 6 / 18 ? 2 : 1;
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null; // dry output
let echo: GainNode | null = null;   // send into the echo line
const pulses = new Map<number, PeriodicWave>();

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    // Take the fizz off the top of the square waves without losing the 8-bit edge.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 7000;
    tone.connect(ctx.destination);
    master = ctx.createGain();
    master.gain.value = 0.32;
    master.connect(tone);
    // Echo: a delay that feeds back into itself, darker each repeat.
    echo = ctx.createGain();
    echo.gain.value = 0.38;
    const delay = ctx.createDelay(1), feedback = ctx.createGain(), dark = ctx.createBiquadFilter();
    delay.delayTime.value = 0.15;
    feedback.gain.value = 0.38;
    dark.type = 'lowpass';
    dark.frequency.value = 2600;
    echo.connect(delay);
    delay.connect(dark).connect(feedback).connect(delay);
    dark.connect(master);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/**
 * Browsers keep audio locked until the page is touched. Called from the first
 * pointer or key press so later sounds (like a timeout reveal) can play.
 */
export function unlockAudio() { audio(); }

/** A pulse wave with the given duty cycle (0.5 is a square; 0.25 and 0.125 are the thinner console leads). */
function pulse(ac: AudioContext, duty: number): PeriodicWave {
  let wave = pulses.get(duty);
  if (!wave) {
    const n = 48, real = new Float32Array(n), imag = new Float32Array(n);
    for (let k = 1; k < n; k++) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
    wave = ac.createPeriodicWave(real, imag);
    pulses.set(duty, wave);
  }
  return wave;
}

type Voice = { duty?: number; triangle?: boolean; hold: number; release: number; volume: number; vibrato?: number };

/** One chip voice: quick attack, a small dip to a sustain level, hold, then a fade into the echo. */
function voice(freq: number, start: number, v: Voice) {
  const ac = ctx!, osc = ac.createOscillator(), g = ac.createGain();
  if (v.triangle) osc.type = 'triangle';
  else osc.setPeriodicWave(pulse(ac, v.duty ?? 0.25));
  osc.frequency.value = freq;
  const end = start + v.hold + v.release;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(v.volume, start + 0.008);
  g.gain.linearRampToValueAtTime(v.volume * 0.75, start + 0.09);
  g.gain.setValueAtTime(v.volume * 0.75, start + v.hold);
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  if (v.vibrato) {
    // Vibrato eases in after the attack, as on a held chiptune lead.
    const lfo = ac.createOscillator(), depth = ac.createGain();
    lfo.frequency.value = 5.5;
    depth.gain.setValueAtTime(0, start);
    depth.gain.linearRampToValueAtTime(0, start + 0.18);
    depth.gain.linearRampToValueAtTime(freq * v.vibrato, start + 0.45);
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(start);
    lfo.stop(end + 0.05);
  }
  osc.connect(g);
  g.connect(master!);
  g.connect(echo!);
  osc.start(start);
  osc.stop(end + 0.05);
}

/**
 * Mix levels in dB, all relative to the verdict-button "pop" (0 dB). They were set by
 * rendering each sound offline and comparing its loudest 30 ms; the long notes sit a
 * little lower than the clicks because a sustained note sounds louder than a short
 * one at the same level. Raise or lower a single sound here.
 */
const LEVEL = { choice: 0, menu: 8.5, round: -5, final: -9, wildcard: -1, timer: 7 };
const db = (x: number) => Math.pow(10, x / 20);

export function playRound(tier: Tier) {
  const ac = audio(); if (!ac) return;
  const l = db(LEVEL.round);
  voice(ROUND_NOTE[tier], ac.currentTime + 0.01, { duty: 0.25, hold: 0.32, release: 0.55, volume: 0.5 * l, vibrato: 0.006 });
}

export function playFinal(tier: Tier) {
  const ac = audio(); if (!ac) return;
  const [a, b] = FINAL_NOTES[tier], t = ac.currentTime + 0.05, second = t + 0.3, l = db(LEVEL.final);
  // The first note keeps sounding, softer, under the second so the pair forms a chord.
  voice(a, t, { duty: 0.25, hold: 0.3, release: 1.1, volume: 0.42 * l });
  voice(b, second, { duty: 0.25, hold: 0.9, release: 1.2, volume: 0.5 * l, vibrato: 0.007 });
  voice(b / 2, second, { triangle: true, hold: 0.9, release: 1.0, volume: 0.55 * l });
}

export function playWildcard() {
  const ac = audio(); if (!ac) return;
  voice(NOTE.A5, ac.currentTime + 0.01, { duty: 0.125, hold: 0.22, release: 0.6, volume: 0.42 * db(LEVEL.wildcard), vibrato: 0.01 });
}

/**
 * The countdown over the last 10 seconds: a thin, clock-like "tick-tock" alternating
 * G5 and E5, which climbs to C6 for the final three seconds.
 */
export function playTimer(secondsLeft: number) {
  const ac = audio(); if (!ac) return;
  const freq = secondsLeft <= 3 ? NOTE.C6 : secondsLeft % 2 === 0 ? NOTE.G5 : NOTE.E5;
  blip(ac, ac.currentTime, freq, 0.06, 0.5 * db(LEVEL.timer), 0.125);
}

let crunch: AudioBuffer | null = null;

/** Console-style noise: random values held for a few samples, which gives the grainy 8-bit texture. */
function noiseBuffer(ac: AudioContext): AudioBuffer {
  if (!crunch) {
    const len = Math.floor(ac.sampleRate * 0.05), hold = 3;
    crunch = ac.createBuffer(1, len, ac.sampleRate);
    const d = crunch.getChannelData(0);
    let v = 0;
    for (let i = 0; i < len; i++) { if (i % hold === 0) v = Math.random() * 2 - 1; d[i] = v; }
  }
  return crunch;
}

/** A fixed-pitch blip with a fast fade: no pitch slide, so it never sounds like a laser. */
function blip(ac: AudioContext, start: number, freq: number, length: number, volume: number, wave: OscillatorType | number) {
  const osc = ac.createOscillator(), g = ac.createGain();
  if (typeof wave === 'number') osc.setPeriodicWave(pulse(ac, wave)); else osc.type = wave;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.linearRampToValueAtTime(volume, start + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(g).connect(master!);
  osc.start(start);
  osc.stop(start + length + 0.01);
}

/**
 * Two clicks so the menu and the game feel different:
 * - menu: a crisp, short wooden "tk" (a burst of 8-bit noise over a tiny high pip)
 * - choice (FACT / KINDA / NOPE): a rounder, lower "pop" on C5
 */
export function playClick(kind: 'menu' | 'choice' = 'menu') {
  const ac = audio(); if (!ac) return;
  const t = ac.currentTime;
  if (kind === 'choice') {
    blip(ac, t, NOTE.C5, 0.07, 0.42, 0.5);
    blip(ac, t, NOTE.C5 / 2, 0.06, 0.4, 'triangle');
    return;
  }
  const src = ac.createBufferSource(), hp = ac.createBiquadFilter(), g = ac.createGain();
  src.buffer = noiseBuffer(ac);
  hp.type = 'highpass';
  hp.frequency.value = 1800;
  const l = db(LEVEL.menu);
  g.gain.setValueAtTime(0.55 * l, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.022);
  src.connect(hp).connect(g).connect(master!);
  src.start(t);
  src.stop(t + 0.03);
  blip(ac, t, NOTE.C6, 0.02, 0.16 * l, 'triangle');
}

/** Buttons and links drawn as a box (border or filled background) get a click; plain text links do not. */
export function isBoxed(el: Element): boolean {
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return false;
  const drawn = (cs: CSSStyleDeclaration) =>
    (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') ||
    cs.backgroundImage !== 'none' || !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor);
  // The paper-scrap buttons (wildcards, home menu) paint their box on ::before.
  const before = getComputedStyle(el, '::before');
  return drawn(getComputedStyle(el)) || (before.content !== 'none' && drawn(before));
}
