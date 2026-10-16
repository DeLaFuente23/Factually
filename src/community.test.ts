import { describe, expect, it } from 'vitest';
import type { Claim } from './game';
import { estimateCommunityStats, mapRealStats } from './community';

const claims: Claim[] = [
  { id: 'f', category: 'FACT', claim: 'Fact', explanation: '', sources: [], replacementEligible: true, obscurity: 1 },
  { id: 'k', category: 'KINDA', claim: 'Kind of', explanation: '', sources: [], replacementEligible: true, obscurity: 5 },
  { id: 'b', category: 'BULLSHIT', claim: 'False', explanation: '', sources: [], replacementEligible: true, obscurity: 10 },
];

describe('expected daily community stats', () => {
  it('are deterministic for a challenge date', () => {
    expect(estimateCommunityStats('2026-10-15', claims)).toEqual(estimateCommunityStats('2026-10-15', claims));
    expect(estimateCommunityStats('2026-10-15', claims).mode).toBe('expected');
  });
  it('maps obscurity 1 and 10 to the documented 95% and 5% expected success', () => {
    const stats = estimateCommunityStats('2026-10-15', claims);
    expect(stats.claims.find(claim => claim.id === 'f')?.accuracy).toBe(0.95);
    expect(stats.claims.find(claim => claim.id === 'b')?.accuracy).toBe(0.05);
  });
  it('keeps the expected score under the 10-point cap', () => {
    expect(estimateCommunityStats('2026-10-15', claims).averageScore).toBeLessThanOrEqual(10);
  });
  it('reports a positive score spread and a perfect-game probability between 0 and 1', () => {
    const stats = estimateCommunityStats('2026-10-15', claims);
    expect(stats.stdDev).toBeGreaterThan(0);
    expect(stats.perfectPotential).toBeGreaterThan(0);
    expect(stats.perfectPotential).toBeLessThanOrEqual(1);
    expect(stats.perfectCount).toBe(0);
  });
});

describe('real community data mapping', () => {
  it('normalizes aggregate values from the stats endpoint', () => {
    const stats = mapRealStats({ submissions: 100, averageScore: 6.5, bins: [1, 2, 3, 4, 90], wildcardAverage: 1.25, claims: [{ id: 'f', category: 'FACT', responses: 100, correct: 75 }], categories: [{ category: 'FACT', responses: 300, correct: 210 }] });
    expect(stats.mode).toBe('real');
    expect(stats.averageScore).toBe(6.5);
    expect(stats.claims[0].accuracy).toBe(0.75);
    expect(stats.categories[0].accuracy).toBe(0.7);
  });
  it('turns the perfect-game count into a share and a spread for the bell curve', () => {
    const stats = mapRealStats({ submissions: 200, averageScore: 6, perfect: 20, bins: [5, 20, 60, 80, 35], wildcardAverage: 1, claims: [], categories: [] });
    expect(stats.perfectCount).toBe(20);
    expect(stats.perfectPotential).toBeCloseTo(0.1);
    expect(stats.stdDev).toBeGreaterThan(0);
  });
});
