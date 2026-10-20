import type { Category, Claim } from './game';

export type ScoreBin = { label: string; count: number };
export type ClaimStat = { id: string; category: Category; responses: number; correct: number; accuracy: number; mostCommonWrong?: Category | null; mostCommonWrongCount?: number };
export type CategoryStat = { category: Category; responses: number; correct: number; accuracy: number };
export type CommunityStats = {
  mode: 'expected' | 'real';
  submissions: number;
  averageScore: number;
  /** Spread of the score distribution, used to draw the bell curve. */
  stdDev: number;
  bins: ScoreBin[];
  wildcardAverage: number;
  /** Rescaled 0-1 index (expected mode) or observed share (real mode) of perfect 10/10 games. */
  perfectPotential: number;
  /** Number of completed 10/10 games (real mode only). */
  perfectCount: number;
  claims: ClaimStat[];
  categories: CategoryStat[];
};

const binLabels = ['0–1.99', '2–3.99', '4–5.99', '6–7.99', '8–10'];
/** Midpoint of each score bin, used to recover a spread from a histogram. */
export const BIN_CENTERS = [1, 3, 5, 7, 9];
function hash(text: string): number {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}
function randomFor(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pointsBin = (score: number) => Math.min(4, Math.floor(score / 2));

/** Recovers an approximate spread when only a five-bin histogram and its mean are available. */
export function estimateStdDevFromBins(bins: ScoreBin[], mean: number): number {
  const weights = bins.map(bin => Math.max(0, bin.count));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!total) return 2;
  const variance = weights.reduce((sum, weight, index) => sum + weight * (BIN_CENTERS[index] - mean) ** 2, 0) / total;
  return Math.max(0.5, Math.sqrt(variance));
}

/** Deterministic, clearly estimated baseline; not a model of verified player behavior. */
export function estimateCommunityStats(date: string, claims: Claim[]): CommunityStats {
  const success = (claim: Claim) => Math.max(0.05, Math.min(0.95, (105 - 10 * claim.obscurity) / 100));
  const expectedClaimScore = claims.reduce((sum, claim) => {
    const p = success(claim);
    return sum + p + (1 - p) * 0.25;
  }, 0);
  const estimatedWildcardsUsed = expectedClaimScore >= 7 ? 0 : expectedClaimScore >= 5 ? 1 : expectedClaimScore >= 3 ? 2 : 3;
  const bonus = (3 - estimatedWildcardsUsed) / 3;
  const rng = randomFor(hash(`factually-community-v1:${date}`));
  const iterations = 12000;
  const scores: number[] = [];
  const binCounts = [0, 0, 0, 0, 0];
  for (let run = 0; run < iterations; run++) {
    const claimScore = claims.reduce((sum, claim) => rng() < success(claim) ? sum + 1 : sum + 0.25, 0);
    const score = Math.min(10, claimScore + bonus);
    scores.push(score);
    binCounts[pointsBin(score)]++;
  }
  const averageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const stdDev = Math.sqrt(scores.reduce((sum, score) => sum + (score - averageScore) ** 2, 0) / scores.length);
  // The score model already credits accidental correct guesses by using
  // p + (1 - p) * 0.25 per claim. A raw product of nine success rates is a true
  // probability, but it collapses toward 0 on any ordinary claim set, so the
  // reader only ever sees 0%. Report it on a log scale between a fully opaque
  // and a fully transparent claim set instead, which keeps the value informative
  // and inside (0, 1) without ever pinning the display at 0% or 100%.
  const easiestSet = success({ obscurity: 1 } as Claim) ** claims.length;
  const hardestSet = success({ obscurity: 10 } as Claim) ** claims.length;
  const rawPerfect = claims.reduce((product, claim) => product * success(claim), 1);
  const logSpan = Math.log(easiestSet) - Math.log(hardestSet);
  const perfectPotential = logSpan > 0
    ? (Math.log(rawPerfect) - Math.log(hardestSet)) / logSpan
    : 0;
  const groups = new Map<Category, Claim[]>();
  for (const claim of claims) groups.set(claim.category, [...(groups.get(claim.category) ?? []), claim]);
  const categories = [...groups].map(([category, categoryClaims]) => {
    const accuracy = categoryClaims.reduce((sum, claim) => sum + success(claim), 0) / categoryClaims.length;
    return { category, responses: categoryClaims.length, correct: Math.round(accuracy * categoryClaims.length), accuracy };
  });
  const claimStats = claims.map(claim => ({ id: claim.id, category: claim.category, responses: 0, correct: 0, accuracy: success(claim) }));
  const expectedWildcardAverage = estimatedWildcardsUsed;
  return {
    mode: 'expected', submissions: 0, averageScore, stdDev,
    bins: binLabels.map((label, index) => ({ label, count: binCounts[index] / iterations })),
    wildcardAverage: expectedWildcardAverage, perfectPotential, perfectCount: 0, claims: claimStats, categories,
  };
}

export function mapRealStats(data: any): CommunityStats {
  const submissions = Number(data?.submissions ?? 0);
  const claims: ClaimStat[] = Array.isArray(data?.claims) ? data.claims.map((c: any) => ({
    id: String(c.id), category: c.category as Category, responses: Number(c.responses), correct: Number(c.correct),
    accuracy: Number(c.responses) ? Number(c.correct) / Number(c.responses) : 0,
    mostCommonWrong: c.mostCommonWrong ?? null, mostCommonWrongCount: Number(c.mostCommonWrongCount ?? 0),
  })) : [];
  const categories: CategoryStat[] = Array.isArray(data?.categories) ? data.categories.map((c: any) => ({
    category: c.category as Category, responses: Number(c.responses), correct: Number(c.correct),
    accuracy: Number(c.responses) ? Number(c.correct) / Number(c.responses) : 0,
  })) : [];
  const averageScore = Number(data?.averageScore ?? 0);
  const bins = binLabels.map((label, index) => ({ label, count: Number(data?.bins?.[index] ?? 0) }));
  const perfectCount = Number(data?.perfect ?? 0);
  return {
    mode: 'real', submissions, averageScore, stdDev: estimateStdDevFromBins(bins, averageScore),
    bins, wildcardAverage: Number(data?.wildcardAverage ?? 0),
    perfectPotential: submissions > 0 ? perfectCount / submissions : 0, perfectCount, claims, categories,
  };
}
