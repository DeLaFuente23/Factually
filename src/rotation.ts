// Claim rotation: the daily nine are drawn from a rotating pool instead of being
// consumed once and never seen again.
//
// The rules, in the order they bind:
//
//   1. Batch rule   - two claims that have ever shared a day may never share a
//                     day again. The batch is the whole nine, so the day's claims
//                     come from nine different earlier days.
//   2. Pair rule    - at most one member of a permanent swap pair per day, so a
//                     Swap can never put a duplicate on the table.
//   3. Cooldown     - a claim that was exposed (as one of the nine, or as a Swap
//                     replacement) cannot be used again until it has been absent
//                     for COOLDOWN_DAYS days.
//   4. Composition  - the fresh period uses three new claims per category; the
//                     mixed period aims for two new and one returning, degrading
//                     through a ladder when that is not possible.
//
// The solver is pure and deterministic given an injected random source, so the
// rules can be proved by tests. The database remains authoritative for the write:
// it re-checks every hard rule before persisting a day.

import type { Category } from './game';

// This module is imported by the Edge Function, so it deliberately has no
// runtime imports: everything it needs is either a type (erased at compile time)
// or defined here.

/**
 * Fisher-Yates shuffle with an injectable source of randomness, so the solver
 * can be driven deterministically from tests.
 */
export function shuffle<T>(input: T[], random: () => number = Math.random): T[] {
  const out = [...input];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const ROTATION_CATEGORIES: Category[] = ['FACT', 'KINDA', 'BULLSHIT'];
export const ROTATION_CLAIMS_PER_CATEGORY = 3;
export const ROTATION_CLAIMS_PER_CHALLENGE = ROTATION_CLAIMS_PER_CATEGORY * 3;
/** A claim must be absent for this many days before it can be used again. */
export const COOLDOWN_DAYS = 21;

/**
 * Composition ladder. Each rung is `[new claims, returning claims]` for one
 * category and always sums to three.
 *
 * The fresh period wants three new claims. The mixed period wants two new and one
 * returning. When the target cannot be met the ladder degrades one step at a
 * time: prefer keeping new material flowing over keeping the mix exactly on
 * target, and never fail a day that can still be built legally.
 */
export const FRESH_LADDER: readonly (readonly [number, number])[] = [
  [3, 0], [2, 1], [1, 2], [0, 3],
];
export const MIXED_LADDER: readonly (readonly [number, number])[] = [
  [2, 1], [1, 2], [3, 0], [0, 3],
];

export type RotationCandidate = {
  id: string;
  category: Category;
  /** True when the claim has never been one of the nine. */
  isNew: boolean;
  /** Most recent exposure, as one of the nine or as a Swap replacement. */
  lastExposureDate: string | null;
  /** Order-independent identity of the permanent swap pair. */
  pairKey: string;
};

export type RotationBatch = { date: string; claimIds: string[] };

export type RotationContext = {
  /** The day being generated. */
  date: string;
  candidates: RotationCandidate[];
  /** Every stored day. The current date is excluded by the caller. */
  batches: RotationBatch[];
  /** Half of each category's library size, snapshotted when the rotation began. */
  thresholds: Record<Category, number>;
  /** Distinct claims that have been one of the nine, per category, all time. */
  usedCounts: Record<Category, number>;
  /** The first day the mixed period applied. Null while the rotation is fresh. */
  mixingStartedAt: string | null;
  cooldownDays?: number;
};

export type RotationPhase = 'fresh' | 'mixed';

export type RotationRung = { new: number; returning: number; label: string };

export type RotationComposition = Record<Category, RotationRung>;

export type RotationRounds = { round: number; claim_ids: string[] }[];

export type RotationSolution = {
  rounds: RotationRounds;
  composition: RotationComposition;
  phase: RotationPhase;
  /** True when any category had to step down the composition ladder. */
  degraded: boolean;
};

export type RotationFailure = { error: string };

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Whole days between two ISO dates, ignoring time of day. */
export function daysBetween(fromIso: string, toIso: string): number {
  return dayNumber(toIso) - dayNumber(fromIso);
}

function dayNumber(iso: string): number {
  const parsed = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed)) throw new Error(`Invalid date: ${iso}`);
  return Math.floor(parsed / 86400000);
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

/**
 * Whether the day is built from the fresh ladder or the mixed one.
 *
 * The switch is one-way. The threshold is checked after a day's claims are
 * assigned: once every category has used at least half its library, the next day
 * is the first mixed day. `mixingStartedAt` records that date.
 */
export function rotationPhase(context: RotationContext): RotationPhase {
  if (context.mixingStartedAt) {
    return context.date >= context.mixingStartedAt ? 'mixed' : 'fresh';
  }
  // Recovery case: the thresholds are already met but the latch was never set.
  return allCategoriesAtThreshold(context) ? 'mixed' : 'fresh';
}

export function allCategoriesAtThreshold(context: RotationContext): boolean {
  return ROTATION_CATEGORIES.every(
    (category) => (context.usedCounts[category] ?? 0) >= (context.thresholds[category] ?? 0),
  );
}

export function ladderFor(phase: RotationPhase): readonly (readonly [number, number])[] {
  return phase === 'fresh' ? FRESH_LADDER : MIXED_LADDER;
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/**
 * Maps each claim to the claims it has already shared a day with. Two claims in
 * the same set can never appear on the same day again.
 */
export function buildConflictMap(batches: RotationBatch[]): Map<string, Set<string>> {
  const conflicts = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let set = conflicts.get(a);
    if (!set) { set = new Set(); conflicts.set(a, set); }
    set.add(b);
  };
  for (const batch of batches) {
    const ids = batch.claimIds;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        link(ids[i], ids[j]);
        link(ids[j], ids[i]);
      }
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

const SEARCH_BUDGET = 60000;
const RESTARTS = 6;

/**
 * Builds the nine claims for a day.
 *
 * Returns `{ error }` when no legal day exists at all, which happens only when a
 * category has no claim that satisfies the cooldown and the batch rule.
 */
export function selectRotatedClaims(
  context: RotationContext,
  random: () => number = Math.random,
): RotationSolution | RotationFailure {
  const phase = rotationPhase(context);
  const ladder = ladderFor(phase);
  const cooldown = context.cooldownDays ?? COOLDOWN_DAYS;
  const today = dayNumber(context.date);

  const byId = new Map(context.candidates.map((candidate) => [candidate.id, candidate]));
  const pool = new Map<Category, RotationCandidate[]>();
  for (const candidate of context.candidates) {
    const list = pool.get(candidate.category) ?? [];
    list.push(candidate);
    pool.set(candidate.category, list);
  }

  const conflicts = buildConflictMap(context.batches.filter((batch) => batch.date !== context.date));

  /** A claim may be used when it is off cooldown and is of the wanted kind. */
  const usable = (candidate: RotationCandidate, wantNew: boolean): boolean => {
    if (candidate.isNew !== wantNew) return false;
    if (candidate.lastExposureDate === null) return true;
    return today - dayNumber(candidate.lastExposureDate) >= cooldown;
  };

  type Search = { used: Set<string>; blocked: Set<string>; pairs: Set<string> };

  /**
   * Places one category's three claims. The order of `wantNew` decides which
   * slots are new and which are returning, so the pool for each slot is known
   * before anything is chosen.
   */
  const placeCategory = (
    category: Category,
    wantNew: boolean[],
    state: Search,
    budget: { steps: number },
  ): string[] | null => {
    const list = pool.get(category) ?? [];
    const step = (index: number, current: Search): string[] | null => {
      if (index >= wantNew.length) return [];
      if (budget.steps++ > SEARCH_BUDGET) return null;
      const options = list.filter(
        (candidate) =>
          usable(candidate, wantNew[index]) &&
          !current.used.has(candidate.id) &&
          !current.blocked.has(candidate.id) &&
          !current.pairs.has(candidate.pairKey),
      );
      if (!options.length) return null;
      for (const candidate of shuffle(options, random)) {
        const next: Search = {
          used: new Set(current.used),
          blocked: new Set(current.blocked),
          pairs: new Set(current.pairs),
        };
        next.used.add(candidate.id);
        next.pairs.add(candidate.pairKey);
        for (const other of conflicts.get(candidate.id) ?? []) next.blocked.add(other);
        const rest = step(index + 1, next);
        if (rest) return [candidate.id, ...rest];
        if (budget.steps > SEARCH_BUDGET) return null;
      }
      return null;
    };
    return step(0, state);
  };

  /**
   * Places all three categories. The batch rule spans categories, so a FACT
   * claim chosen here can rule out a KINDA claim that shared an earlier day with
   * it; the categories are therefore solved together.
   */
  const placeAll = (
    index: number,
    state: Search,
    picks: Record<Category, string[]>,
    rungs: Record<Category, number>,
    budget: { steps: number },
  ): boolean => {
    if (index >= ROTATION_CATEGORIES.length) return true;
    const category = ROTATION_CATEGORIES[index];
    for (let rung = 0; rung < ladder.length; rung++) {
      const [newCount, returningCount] = ladder[rung];
      const wantNew = [
        ...new Array<boolean>(newCount).fill(true),
        ...new Array<boolean>(returningCount).fill(false),
      ];
      const chosen = placeCategory(category, wantNew, state, budget);
      if (!chosen) continue;
      const next: Search = {
        used: new Set(state.used),
        blocked: new Set(state.blocked),
        pairs: new Set(state.pairs),
      };
      for (const id of chosen) {
        next.used.add(id);
        const candidate = byId.get(id);
        if (candidate) next.pairs.add(candidate.pairKey);
        for (const other of conflicts.get(id) ?? []) next.blocked.add(other);
      }
      picks[category] = chosen;
      rungs[category] = rung;
      if (placeAll(index + 1, next, picks, rungs, budget)) return true;
    }
    return false;
  };

  for (let attempt = 0; attempt < RESTARTS; attempt++) {
    const budget = { steps: 0 };
    const picks: Record<Category, string[]> = { FACT: [], KINDA: [], BULLSHIT: [] };
    const rungs: Record<Category, number> = { FACT: 0, KINDA: 0, BULLSHIT: 0 };
    const state: Search = { used: new Set(), blocked: new Set(), pairs: new Set() };
    if (!placeAll(0, state, picks, rungs, budget)) continue;

    // One claim per category per round, in a random order.
    const orders = ROTATION_CATEGORIES.map((category) => shuffle(picks[category], random));
    const rounds: RotationRounds = [0, 1, 2].map((index) => ({
      round: index + 1,
      claim_ids: orders.map((order) => order[index]),
    }));

    const composition = {} as RotationComposition;
    let degraded = false;
    for (const category of ROTATION_CATEGORIES) {
      const chosen = picks[category];
      const newCount = chosen.filter((id) => byId.get(id)?.isNew).length;
      const [targetNew, targetReturning] = ladder[rungs[category]];
      composition[category] = {
        new: newCount,
        returning: chosen.length - newCount,
        label: `${targetNew} new + ${targetReturning} returning`,
      };
      if (rungs[category] !== 0) degraded = true;
    }

    return { rounds, composition, phase, degraded };
  }

  return {
    error: 'No legal combination of claims is available for this day.',
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Checks a day against every rule the rotation enforces. Used by the tests and
 * mirrored by the database, which re-checks before it persists anything.
 */
export function validateRotatedClaims(context: RotationContext, rounds: RotationRounds): string[] {
  const problems: string[] = [];
  const byId = new Map(context.candidates.map((candidate) => [candidate.id, candidate]));
  const cooldown = context.cooldownDays ?? COOLDOWN_DAYS;
  const today = dayNumber(context.date);

  if (rounds.length !== 3) problems.push(`expected 3 rounds, found ${rounds.length}`);
  const all: string[] = [];
  for (const round of rounds) {
    if (round.claim_ids.length !== 3) problems.push(`round ${round.round} has ${round.claim_ids.length} claims`);
    const categories = round.claim_ids.map((id) => byId.get(id)?.category);
    if (categories.some((category) => !category)) problems.push(`round ${round.round} references an unknown claim`);
    else if (new Set(categories).size !== 3) problems.push(`round ${round.round} does not have one claim per verdict`);
    all.push(...round.claim_ids);
  }
  if (all.length !== ROTATION_CLAIMS_PER_CHALLENGE) {
    problems.push(`expected ${ROTATION_CLAIMS_PER_CHALLENGE} claims, found ${all.length}`);
  }
  if (new Set(all).size !== all.length) problems.push('the nine claims are not distinct');

  // Pair rule.
  const pairKeys = all.map((id) => byId.get(id)?.pairKey).filter((key): key is string => Boolean(key));
  if (new Set(pairKeys).size !== pairKeys.length) problems.push('two claims share a swap pair');

  // Cooldown.
  for (const id of all) {
    const candidate = byId.get(id);
    if (!candidate?.lastExposureDate) continue;
    const gap = today - dayNumber(candidate.lastExposureDate);
    if (gap < cooldown) problems.push(`${id} was exposed ${gap} days ago, inside the ${cooldown}-day cooldown`);
  }

  // Batch rule.
  const conflicts = buildConflictMap(context.batches.filter((batch) => batch.date !== context.date));
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (conflicts.get(all[i])?.has(all[j])) {
        problems.push(`${all[i]} and ${all[j]} have already shared a day`);
      }
    }
  }

  return problems;
}
