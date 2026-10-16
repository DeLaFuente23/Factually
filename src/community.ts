import type { Category, Claim } from './game';

export type ScoreBin = { label: string; count: number };
export type ClaimStat = { id: string; category: Category; responses: number; correct: number; accuracy: number; mostCommonWrong?: Category | null; mostCommonWrongCount?: number };
export type CategoryStat = { category: Category; responses: number; correct: number; accuracy: number };
export type CommunityStats = {
  mode: 'expected' | 'real';
  submissions: number;
  averageScore: number;
  bins: ScoreBin[];
  wildcardAverage: number;
  claims: ClaimStat[];
  categories: CategoryStat[];
};

const binLabels = ['0–1.99', '2–3.99', '4–5.99', '6–7.99', '8–10'];
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
  const groups = new Map<Category, Claim[]>();
  for (const claim of claims) groups.set(claim.category, [...(groups.get(claim.category) ?? []), claim]);
  const categories = [...groups].map(([category, categoryClaims]) => {
    const accuracy = categoryClaims.reduce((sum, claim) => sum + success(claim), 0) / categoryClaims.length;
    return { category, responses: categoryClaims.length, correct: Math.round(accuracy * categoryClaims.length), accuracy };
  });
  const claimStats = claims.map(claim => ({ id: claim.id, category: claim.category, responses: 0, correct: 0, accuracy: success(claim) }));
  const expectedWildcardAverage = estimatedWildcardsUsed;
  return {
    mode: 'expected', submissions: 0, averageScore,
    bins: binLabels.map((label, index) => ({ label, count: binCounts[index] / iterations })),
    wildcardAverage: expectedWildcardAverage, claims: claimStats, categories,
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
  return {
    mode: 'real', submissions, averageScore: Number(data?.averageScore ?? 0),
    bins: binLabels.map((label, index) => ({ label, count: Number(data?.bins?.[index] ?? 0) })),
    wildcardAverage: Number(data?.wildcardAverage ?? 0), claims, categories,
  };
}
