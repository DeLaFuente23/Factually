import { describe, it, expect } from 'vitest';
import type { Category } from './game';
import {
  COOLDOWN_DAYS, FRESH_LADDER, MIXED_LADDER, ROTATION_CATEGORIES, buildConflictMap,
  daysBetween, ladderFor, rotationPhase, selectRotatedClaims, validateRotatedClaims,
  type RotationCandidate, type RotationContext, type RotationRounds,
} from './rotation';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t ^ (t >>> 7));
    t ^= t + Math.imul(t ^ (t >>> 7), t ^ (t >>> 15));
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIZES: Record<Category, number> = { FACT: 12, KINDA: 8, BULLSHIT: 8 };

/**
 * A library of synthetic claims with permanent disjoint swap pairs.
 *
 * `used` marks the first n claims of each category as already seen, so the
 * mixed period has a returning pool to draw from.
 */
function makeCandidates(
  sizes: Record<Category, number> = SIZES,
  used = 0,
  exposure = '2020-01-01',
): RotationCandidate[] {
  const out: RotationCandidate[] = [];
  for (const category of ROTATION_CATEGORIES) {
    for (let i = 1; i <= sizes[category]; i++) {
      const id = `${category.toLowerCase()}-${i}`;
      const partner = i % 2 === 1 ? `${category.toLowerCase()}-${i + 1}` : `${category.toLowerCase()}-${i - 1}`;
      out.push({
        id,
        category,
        isNew: i > used,
        lastExposureDate: i <= used ? exposure : null,
        pairKey: [id, partner].sort().join('|'),
      });
    }
  }
  return out;
}

const thresholdsFor = (sizes: Record<Category, number>): Record<Category, number> => ({
  FACT: Math.ceil(sizes.FACT / 2),
  KINDA: Math.ceil(sizes.KINDA / 2),
  BULLSHIT: Math.ceil(sizes.BULLSHIT / 2),
});

function makeContext(date: string, overrides: Partial<RotationContext> = {}): RotationContext {
  const candidates = overrides.candidates ?? makeCandidates();
  return {
    date,
    candidates,
    batches: [],
    thresholds: thresholdsFor(SIZES),
    usedCounts: { FACT: 0, KINDA: 0, BULLSHIT: 0 },
    mixingStartedAt: null,
    ...overrides,
  };
}

/** ISO date `offset` days after `base`. */
function day(base: string, offset: number): string {
  const date = new Date(`${base}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

describe('1. the fresh period uses three new claims per category', () => {
  it('builds a fresh day with no returning claims', () => {
    const context = makeContext('2026-01-01');
    const result = selectRotatedClaims(context, seeded(1));
    if (!('rounds' in result)) throw new Error('selection failed');
    expect(result.phase).toBe('fresh');
    for (const category of ROTATION_CATEGORIES) {
      expect(result.composition[category].new).toBe(3);
      expect(result.composition[category].returning).toBe(0);
    }
  });

  it('uses the fresh ladder while the thresholds are unmet', () => {
    expect(ladderFor('fresh')).toEqual(FRESH_LADDER);
    expect(ladderFor('mixed')).toEqual(MIXED_LADDER);
    expect(FRESH_LADDER[0]).toEqual([3, 0]);
    expect(MIXED_LADDER[0]).toEqual([2, 1]);
  });
});

describe('2. the mixed period aims for two new and one returning claim', () => {
  it('switches to the mixed ladder once the latch is set', () => {
    const context = makeContext('2026-02-01', {
      candidates: makeCandidates(SIZES, 4, '2026-01-01'),
      mixingStartedAt: '2026-01-20',
    });
    const result = selectRotatedClaims(context, seeded(2));
    if (!('rounds' in result)) throw new Error('selection failed');
    expect(result.phase).toBe('mixed');
    for (const category of ROTATION_CATEGORIES) {
      expect(result.composition[category].new).toBe(2);
      expect(result.composition[category].returning).toBe(1);
    }
  });

  it('treats the day the latch names as the first mixed day', () => {
    const before = makeContext('2026-01-19', { mixingStartedAt: '2026-01-20' });
    expect(rotationPhase(before)).toBe('fresh');
    const on = makeContext('2026-01-20', { mixingStartedAt: '2026-01-20' });
    expect(rotationPhase(on)).toBe('mixed');
  });

  it('keeps the fresh phase until every category has reached its threshold', () => {
    const context = makeContext('2026-01-10', {
      usedCounts: { FACT: 6, KINDA: 4, BULLSHIT: 3 },
      thresholds: { FACT: 6, KINDA: 4, BULLSHIT: 4 },
    });
    expect(rotationPhase(context)).toBe('fresh');
    const reached = makeContext('2026-01-10', {
      usedCounts: { FACT: 6, KINDA: 4, BULLSHIT: 4 },
      thresholds: { FACT: 6, KINDA: 4, BULLSHIT: 4 },
    });
    expect(rotationPhase(reached)).toBe('mixed');
  });
});

describe('3. the cooldown keeps a claim away for twenty-one days', () => {
  it('excludes a claim exposed inside the cooldown window', () => {
    const base = makeCandidates(SIZES, 4, '2026-01-01');
    const context = makeContext('2026-03-01', {
      candidates: base,
      mixingStartedAt: '2026-01-01',
    });
    const result = selectRotatedClaims(context, seeded(3));
    if (!('rounds' in result)) throw new Error('selection failed');
    expect(result.rounds.flatMap((round) => round.claim_ids)).toHaveLength(9);

    // fact-2 was exposed yesterday, so the cooldown keeps it out.
    const cold = makeContext('2026-03-01', {
      candidates: base.map((candidate) => (
        candidate.id === 'fact-2'
          ? { ...candidate, lastExposureDate: day('2026-03-01', -1) }
          : candidate
      )),
      mixingStartedAt: '2026-01-01',
    });
    const second = selectRotatedClaims(cold, seeded(3));
    if (!('rounds' in second)) throw new Error('selection failed');
    expect(second.rounds.flatMap((round) => round.claim_ids)).not.toContain('fact-2');
  });

  it('lets a claim come back exactly twenty-one days after its last exposure', () => {
    const base = makeCandidates(SIZES, 4, '2026-01-01');
    // The other returning claims were exposed yesterday, so fact-2 is the only
    // one the mixed period can draw on.
    const only = makeContext('2026-03-01', {
      candidates: base.map((candidate) => {
        if (candidate.id === 'fact-2') return { ...candidate, lastExposureDate: day('2026-03-01', -21) };
        if (candidate.category === 'FACT' && !candidate.isNew) {
          return { ...candidate, lastExposureDate: day('2026-03-01', -1) };
        }
        return candidate;
      }),
      mixingStartedAt: '2026-01-01',
    });
    const result = selectRotatedClaims(only, seeded(11));
    if (!('rounds' in result)) throw new Error('selection failed');
    expect(result.rounds.flatMap((round) => round.claim_ids)).toContain('fact-2');
  });

  it('keeps a claim out one day short of the cooldown', () => {
    const base = makeCandidates(SIZES, 4, '2026-01-01');
    const short = makeContext('2026-03-01', {
      candidates: base.map((candidate) => {
        if (candidate.id === 'fact-2') return { ...candidate, lastExposureDate: day('2026-03-01', -20) };
        if (candidate.category === 'FACT' && !candidate.isNew) {
          return { ...candidate, lastExposureDate: day('2026-03-01', -1) };
        }
        return candidate;
      }),
      mixingStartedAt: '2026-01-01',
    });
    const result = selectRotatedClaims(short, seeded(11));
    if (!('rounds' in result)) throw new Error('selection failed');
    expect(result.rounds.flatMap((round) => round.claim_ids)).not.toContain('fact-2');
  });

  it('allows a claim exactly twenty-one days after its last exposure', () => {
    expect(daysBetween('2026-01-01', '2026-01-22')).toBe(21);
    expect(daysBetween('2026-01-01', '2026-01-21')).toBe(20);
    expect(COOLDOWN_DAYS).toBe(21);
  });
});

describe('4. the batch rule keeps two claims that shared a day apart', () => {
  it('never puts two claims from the same earlier batch on the same day', () => {
    const batch = { date: '2026-01-01', claimIds: ['fact-1', 'kinda-1', 'bull-1'] };
    const context = makeContext('2026-02-01', { batches: [batch], mixingStartedAt: '2026-01-01' });
    for (let seed = 1; seed <= 20; seed++) {
      const result = selectRotatedClaims(context, seeded(seed));
      if (!('rounds' in result)) throw new Error('selection failed');
      const ids = result.rounds.flatMap((round) => round.claim_ids);
      const fromBatch = ids.filter((id) => batch.claimIds.includes(id));
      expect(fromBatch.length).toBeLessThanOrEqual(1);
    }
  });

  it('builds the conflict map symmetrically', () => {
    const conflicts = buildConflictMap([{ date: '2026-01-01', claimIds: ['a', 'b', 'c'] }]);
    expect(conflicts.get('a')?.has('b')).toBe(true);
    expect(conflicts.get('b')?.has('a')).toBe(true);
    expect(conflicts.get('a')?.has('c')).toBe(true);
    expect(conflicts.get('a')?.has('z')).toBe(false);
  });
});

describe('5. the pair rule keeps both members of a swap pair apart', () => {
  it('never selects two claims that share a swap pair', () => {
    const context = makeContext('2026-04-01');
    for (let seed = 1; seed <= 20; seed++) {
      const result = selectRotatedClaims(context, seeded(seed));
      if (!('rounds' in result)) throw new Error('selection failed');
      const ids = result.rounds.flatMap((round) => round.claim_ids);
      const byId = new Map(context.candidates.map((candidate) => [candidate.id, candidate]));
      const keys = ids.map((id) => byId.get(id)!.pairKey);
      expect(new Set(keys).size).toBe(9);
    }
  });
});

describe('6. the ladder degrades instead of failing', () => {
  it('falls back to three returning claims when no new claim is left', () => {
    const candidates = makeCandidates().map((candidate) => ({
      ...candidate,
      isNew: false,
      lastExposureDate: day('2026-05-01', -30),
    }));
    const context = makeContext('2026-05-01', {
      candidates,
      mixingStartedAt: '2026-01-01',
      usedCounts: { FACT: 6, KINDA: 4, BULLSHIT: 4 },
    });
    const result = selectRotatedClaims(context, seeded(6));
    if (!('rounds' in result)) throw new Error('selection failed');
    for (const category of ROTATION_CATEGORIES) {
      expect(result.composition[category].new).toBe(0);
      expect(result.composition[category].returning).toBe(3);
    }
    expect(result.degraded).toBe(true);
  });

  it('reports the rung it used', () => {
    const context = makeContext('2026-06-01');
    const result = selectRotatedClaims(context, seeded(7));
    if (!('rounds' in result)) throw new Error('selection failed');
    expect(result.degraded).toBe(false);
    expect(result.composition.FACT.label).toBe('3 new + 0 returning');
  });
});

describe('7. the validator catches every rule it is given a broken day for', () => {
  const context = makeContext('2026-07-01', {
    batches: [{ date: '2026-06-01', claimIds: ['fact-1', 'kinda-1', 'bull-1'] }],
  });

  it('accepts a legal day', () => {
    const solved = selectRotatedClaims(context, seeded(8));
    if (!('rounds' in solved)) throw new Error('selection failed');
    expect(validateRotatedClaims(context, solved.rounds)).toEqual([]);
  });

  it('rejects a repeated claim', () => {
    const bad: RotationRounds = [
      { round: 1, claim_ids: ['fact-1', 'fact-1', 'bull-2'] },
      { round: 2, claim_ids: ['fact-3', 'kinda-3', 'bull-3'] },
      { round: 3, claim_ids: ['fact-5', 'kinda-5', 'bull-5'] },
    ];
    expect(validateRotatedClaims(context, bad).join(' ')).toMatch(/not distinct/);
  });

  it('rejects two claims that already shared a day', () => {
    const bad: RotationRounds = [
      { round: 1, claim_ids: ['fact-1', 'kinda-1', 'bull-2'] },
      { round: 2, claim_ids: ['fact-3', 'kinda-3', 'bull-3'] },
      { round: 3, claim_ids: ['fact-5', 'kinda-5', 'bull-5'] },
    ];
    expect(validateRotatedClaims(context, bad).join(' ')).toMatch(/already shared a day/);
  });

  it('rejects a claim inside its cooldown', () => {
    const recent = makeContext('2026-07-01', {
      candidates: makeCandidates().map((candidate) => ({
        ...candidate,
        lastExposureDate: candidate.id === 'fact-3' ? day('2026-07-01', -3) : null,
      })),
    });
    const bad: RotationRounds = [
      { round: 1, claim_ids: ['fact-3', 'kinda-7', 'bull-7'] },
      { round: 2, claim_ids: ['fact-5', 'kinda-5', 'bull-5'] },
      { round: 3, claim_ids: ['fact-7', 'kinda-3', 'bull-3'] },
    ];
    expect(validateRotatedClaims(recent, bad).join(' ')).toMatch(/cooldown/);
  });

  it('rejects two claims that share a swap pair', () => {
    const bad: RotationRounds = [
      { round: 1, claim_ids: ['fact-1', 'kinda-7', 'bull-7'] },
      { round: 2, claim_ids: ['fact-2', 'kinda-5', 'bull-5'] },
      { round: 3, claim_ids: ['fact-5', 'kinda-3', 'bull-3'] },
    ];
    expect(validateRotatedClaims(context, bad).join(' ')).toMatch(/swap pair/);
  });
});

describe('8. a long run keeps every rule true on every day', () => {
  it('holds for three hundred consecutive days', () => {
    const sizes: Record<Category, number> = { FACT: 150, KINDA: 100, BULLSHIT: 100 };
    let candidates = makeCandidates(sizes);
    let batches: { date: string; claimIds: string[] }[] = [];
    let usedCounts: Record<Category, number> = { FACT: 0, KINDA: 0, BULLSHIT: 0 };
    let mixingStartedAt: string | null = null;
    const thresholds = thresholdsFor(sizes);
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

    for (let index = 0; index < 300; index++) {
      const date = day('2026-01-01', index);
      const context: RotationContext = {
        date,
        candidates,
        batches,
        thresholds,
        usedCounts,
        mixingStartedAt,
      };
      const result = selectRotatedClaims(context, seeded(index + 1));
      if (!('rounds' in result)) throw new Error(`selection failed on day ${index}: ${result.error}`);

      expect(validateRotatedClaims(context, result.rounds)).toEqual([]);

      const ids = result.rounds.flatMap((round) => round.claim_ids);
      expect(ids).toHaveLength(9);
      expect(new Set(ids).size).toBe(9);

      // Commit the day.
      batches = [...batches, { date, claimIds: ids }];
      candidates = candidates.map((candidate) => (
        ids.includes(candidate.id)
          ? { ...candidate, isNew: false, lastExposureDate: date }
          : candidate
      ));
      for (const id of ids) {
        const category = byId.get(id)!.category;
        if (!usedCounts[category]) usedCounts[category] = 0;
      }
      const usedSoFar = new Set(batches.flatMap((batch) => batch.claimIds));
      for (const category of ROTATION_CATEGORIES) {
        usedCounts[category] = candidates.filter(
          (candidate) => candidate.category === category && usedSoFar.has(candidate.id),
        ).length;
      }
      if (!mixingStartedAt && ROTATION_CATEGORIES.every((category) => usedCounts[category] >= thresholds[category])) {
        mixingStartedAt = day('2026-01-01', index + 1);
      }
    }

    // The rotation really did mix: the library ran dry and the system kept going.
    expect(mixingStartedAt).not.toBeNull();
    expect(batches.length).toBe(300);
  });
});
