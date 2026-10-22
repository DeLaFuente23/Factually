// Shared inventory + daily-challenge domain logic.
//
// This module is intentionally free of DOM, Supabase, and Deno APIs so it can run
// unchanged in three places:
//   1. the Supabase Edge Function (authoritative, server-side),
//   2. the browser bundle (offline fallback + diagnostics),
//   3. Vitest.
//
// Two logical data stores are modelled here and are mirrored by the SQL tables
// `claim_usage` and `challenge_assignments`:
//
//   claim-usage.json      -> ClaimUsageStore
//   daily-challenges.json -> ChallengeStore
//
// Both are exportable to exactly the JSON shape requested in the implementation
// spec, which is how they are backed up and inspected.

import type { Category, Claim } from './game';
import { shuffle } from './rotation';

export const CATEGORIES: Category[] = ['FACT', 'KINDA', 'BULLSHIT'];
export const CLAIMS_PER_ROUND = 3;
export const ROUNDS_PER_CHALLENGE = 3;
export const CLAIMS_PER_CHALLENGE = CLAIMS_PER_ROUND * ROUNDS_PER_CHALLENGE; // 9
export const INVENTORY_VERSION = 1;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Per-claim usage record. The two usage flags are strictly independent. */
export type ClaimUsage = {
  /** Claim has been assigned as one of the nine primary claims. Permanent. */
  used_as_main: boolean;
  /** Claim has been consumed as a wildcard replacement. Permanent. */
  used_as_replacement: boolean;
  /** Permanent, same-category partner. This claim's Swap target. Null if unpaired. */
  replacement_claim_id: string | null;
  /** ISO date (YYYY-MM-DD) this claim was first served as a main claim. */
  main_usage_date: string | null;
  /** ISO date this claim was first consumed as a replacement. */
  replacement_usage_date: string | null;
};

export type ClaimUsageStore = {
  version: number;
  /** Generation timestamp of the last reconciliation, for auditing. */
  reconciled_at?: string;
  claims: Record<string, ClaimUsage>;
};

export type ChallengeRound = { round: number; claim_ids: string[] };

export type DailyChallenge = {
  challenge_id: string;
  generated_at: string;
  status: 'active' | 'archived';
  rounds: ChallengeRound[];
};

export type ChallengeStore = {
  version: number;
  challenges: Record<string, DailyChallenge>;
};

/** A recorded Swap event. Distinct from an assignment (see note in `consumeReplacement`). */
export type ReplacementEvent = {
  challenge_date: string;
  claim_id: string;
  replacement_id: string;
  consumed_at: string;
};

// ---------------------------------------------------------------------------
// Constructors / validation
// ---------------------------------------------------------------------------

export const emptyUsage = (replacementClaimId: string | null = null): ClaimUsage => ({
  used_as_main: false,
  used_as_replacement: false,
  replacement_claim_id: replacementClaimId,
  main_usage_date: null,
  replacement_usage_date: null,
});

export const emptyUsageStore = (): ClaimUsageStore => ({ version: INVENTORY_VERSION, claims: {} });
export const emptyChallengeStore = (): ChallengeStore => ({ version: INVENTORY_VERSION, challenges: {} });

/** A claim is exhaustible only when BOTH roles have been served. */
export const isExhausted = (usage: ClaimUsage): boolean =>
  usage.used_as_main && usage.used_as_replacement;

export const isMainEligible = (usage: ClaimUsage | undefined): boolean =>
  !usage || !usage.used_as_main;

export const isReplacementEligible = (usage: ClaimUsage | undefined): boolean =>
  !usage || !usage.used_as_replacement;

// ---------------------------------------------------------------------------
// Permanent replacement pairing
// ---------------------------------------------------------------------------

/**
 * Builds disjoint one-to-one replacement pairs within each category.
 *
 * Strategy: sort each category's claim IDs with a stable comparator (so the
 * pairing never depends on JSON/storage order), then pair adjacent entries.
 * Because pairs are disjoint, at most one member of any pair can be selected
 * into a challenge, which is what keeps a Swap from duplicating a claim that is
 * already on the table.
 *
 * Every category in the library must have an even number of claims; a leftover
 * claim would be main-only and cannot be paired without breaking one-to-one, so
 * the caller is expected to validate counts first (`validateLibrary`).
 */
export function buildReplacementPairs(claims: { id: string; category: Category }[]): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const category of CATEGORIES) {
    const ids = claims
      .filter((claim) => claim.category === category)
      .map((claim) => claim.id)
      .sort(compareIds);
    for (let i = 0; i + 1 < ids.length; i += 2) {
      pairs.set(ids[i], ids[i + 1]);
      pairs.set(ids[i + 1], ids[i]);
    }
  }
  return pairs;
}

/**
 * Numeric-aware ascending comparator. `fact-2` sorts before `fact-10`, and
 * unlike a plain lexicographic sort the result is independent of how the claim
 * library happens to be ordered on disk.
 */
export function compareIds(a: string, b: string): number {
  const pa = splitId(a);
  const pb = splitId(b);
  if (pa.prefix !== pb.prefix) return pa.prefix < pb.prefix ? -1 : 1;
  if (pa.number !== pb.number) return pa.number - pb.number;
  return a < b ? -1 : a > b ? 1 : 0;
}

function splitId(id: string): { prefix: string; number: number } {
  const match = /^(.*?)(\d+)$/.exec(id);
  return match ? { prefix: match[1], number: Number(match[2]) } : { prefix: id, number: 0 };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type ReconcileReport = {
  added: string[];
  removed: string[];
  repairedPairs: string[];
  invalidCategories: string[];
  duplicateIds: string[];
  brokenReferences: string[];
  /** Categories whose claim count is odd, so one claim cannot be paired. */
  unpairedCategories: Category[];
};

/**
 * Reconciles the usage store against the master library.
 *
 * Guarantees:
 *  - never resets or deletes an existing usage record,
 *  - never re-pairs a claim that already has a valid same-category partner,
 *  - new claims are appended as unused with flags false,
 *  - claims missing from the library are reported, not dropped (history is kept).
 *
 * Returns a new store; the input is not mutated.
 */
export function reconcileUsage(
  library: Claim[],
  store: ClaimUsageStore,
  now: string = new Date().toISOString(),
): { store: ClaimUsageStore; report: ReconcileReport } {
  const report: ReconcileReport = {
    added: [], removed: [], repairedPairs: [], invalidCategories: [],
    duplicateIds: [], brokenReferences: [], unpairedCategories: [],
  };

  const byId = new Map<string, Claim>();
  for (const claim of library) {
    if (byId.has(claim.id)) report.duplicateIds.push(claim.id);
    else byId.set(claim.id, claim);
    if (!CATEGORIES.includes(claim.category)) report.invalidCategories.push(claim.id);
  }

  const claims = Object.fromEntries(
    Object.entries(store.claims).map(([id, usage]) => [id, { ...usage }]),
  ) as Record<string, ClaimUsage>;

  for (const category of CATEGORIES) {
    if (library.filter((claim) => claim.category === category).length % 2 !== 0) {
      report.unpairedCategories.push(category);
    }
  }

  const validIds = new Set(byId.keys());
  for (const id of Object.keys(claims)) if (!validIds.has(id)) report.removed.push(id);

  // Add records for claim IDs the library knows but the store does not.
  for (const claim of library) {
    if (claims[claim.id]) continue;
    claims[claim.id] = emptyUsage();
    report.added.push(claim.id);
  }

  const pairs = buildReplacementPairs(library);
  for (const [id, usage] of Object.entries(claims)) {
    const claim = byId.get(id);
    if (!claim) continue; // removed from the library: freeze the record untouched

    const partnerId = pairs.get(id) ?? null;
    const current = usage.replacement_claim_id;
    const currentValid = current !== null && partnerId !== null && current === partnerId;

    if (current === null && partnerId !== null) {
      usage.replacement_claim_id = partnerId;
    } else if (current !== null && !currentValid) {
      // Broken: partner missing, deleted, renamed, or cross-category.
      const partner = byId.get(current);
      if (!partner || partner.category !== claim.category) report.brokenReferences.push(id);
      usage.replacement_claim_id = partnerId;
      report.repairedPairs.push(id);
    }
  }

  // Broken reference whose target does not exist in the store's own index.
  for (const [id, usage] of Object.entries(claims)) {
    if (usage.replacement_claim_id && !claims[usage.replacement_claim_id]) {
      report.brokenReferences.push(id);
      const partnerId = pairs.get(id) ?? null;
      usage.replacement_claim_id = partnerId;
      if (partnerId) report.repairedPairs.push(id);
    }
  }

  return {
    store: { version: INVENTORY_VERSION, reconciled_at: now, claims },
    report,
  };
}

// ---------------------------------------------------------------------------
// Eligibility + selection
// ---------------------------------------------------------------------------

/** Main-eligible claims in a category, as `Claim` records, in a stable order. */
export function eligibleMainClaims(
  library: Claim[],
  store: ClaimUsageStore,
  category: Category,
  exclude: Iterable<string> = [],
): Claim[] {
  const skip = new Set(exclude);
  return library
    .filter((claim) => claim.category === category && isMainEligible(store.claims[claim.id]) && !skip.has(claim.id))
    .sort((a, b) => compareIds(a.id, b.id));
}

/**
 * Selects the nine primary claims for a challenge.
 *
 * - three per category, randomised over the eligible pool,
 * - at most one member of any replacement pair (so a Swap can never duplicate a
 *   claim already in the challenge),
 * - no claim repeated across rounds.
 *
 * `random` is injectable so tests can drive a deterministic sequence.
 */
export function selectDailyClaims(
  library: Claim[],
  store: ClaimUsageStore,
  random: () => number = Math.random,
): { rounds: ChallengeRound[]; report: { category: Category; needed: number; available: number }[] } | { error: string; report: { category: Category; needed: number; available: number }[] } {
  const needed = ROUNDS_PER_CHALLENGE; // 3 per category
  const chosen: Record<Category, Claim[]> = { FACT: [], KINDA: [], BULLSHIT: [] };
  const report: { category: Category; needed: number; available: number }[] = [];
  const usedPairKeys = new Set<string>();

  for (const category of CATEGORIES) {
    const pool = eligibleMainClaims(library, store, category);
    // Pair identity is order-independent, so both members of a pair map to one key.
    const pairKey = (claim: Claim) => {
      const partner = store.claims[claim.id]?.replacement_claim_id;
      return partner ? [claim.id, partner].sort(compareIds).join('|') : claim.id;
    };

    const available = pool.filter((claim) => !usedPairKeys.has(pairKey(claim)));
    report.push({ category, needed, available: available.length });
    if (available.length < needed) {
      return {
        error: `Not enough eligible ${category} claims: need ${needed}, have ${available.length}.`,
        report,
      };
    }

    const shuffled = shuffle(available, random);
    for (const claim of shuffled) {
      if (chosen[category].length >= needed) break;
      const key = pairKey(claim);
      if (usedPairKeys.has(key)) continue;
      usedPairKeys.add(key);
      chosen[category].push(claim);
    }
  }

  // Distribute across rounds: one claim per category per round, randomised.
  const orders = CATEGORIES.map((category) => shuffle([...chosen[category]], random));
  const rounds: ChallengeRound[] = [0, 1, 2].map((index) => ({
    round: index + 1,
    claim_ids: orders.map((order) => order[index].id),
  }));

  return { rounds, report };
}

/**
 * Fisher-Yates. Lives with the rotation module so the Edge Function can bundle
 * the rotation without pulling in this file.
 */
export { shuffle };

// ---------------------------------------------------------------------------
// Challenge store helpers
// ---------------------------------------------------------------------------

export const challengeClaimIds = (challenge: DailyChallenge): string[] =>
  challenge.rounds.flatMap((round) => round.claim_ids);

export function validateChallenge(
  challenge: DailyChallenge,
  library: Claim[],
): string[] {
  const problems: string[] = [];
  const byId = new Map(library.map((claim) => [claim.id, claim]));
  if (challenge.rounds.length !== ROUNDS_PER_CHALLENGE) {
    problems.push(`expected ${ROUNDS_PER_CHALLENGE} rounds, found ${challenge.rounds.length}`);
  }
  const all: string[] = [];
  for (const round of challenge.rounds) {
    if (round.claim_ids.length !== CLAIMS_PER_ROUND) {
      problems.push(`round ${round.round} has ${round.claim_ids.length} claims`);
    }
    const categories = round.claim_ids.map((id) => byId.get(id)?.category);
    if (categories.some((category) => !category)) problems.push(`round ${round.round} references an unknown claim`);
    else if (new Set(categories).size !== CLAIMS_PER_ROUND) problems.push(`round ${round.round} does not have one claim per verdict`);
    all.push(...round.claim_ids);
  }
  if (all.length === CLAIMS_PER_CHALLENGE && new Set(all).size !== CLAIMS_PER_CHALLENGE) {
    problems.push('primary claims are not distinct');
  }
  return problems;
}

/**
 * Marks the nine primary claims as used. Idempotent: re-running for an existing
 * challenge does not change flags that are already set, and never clears a flag.
 */
export function markMainUsage(
  store: ClaimUsageStore,
  challenge: DailyChallenge,
  date: string,
): ClaimUsageStore {
  const claims = Object.fromEntries(
    Object.entries(store.claims).map(([id, usage]) => [id, { ...usage }]),
  ) as Record<string, ClaimUsage>;
  for (const id of challengeClaimIds(challenge)) {
    const usage = claims[id];
    if (!usage) continue;
    usage.used_as_main = true;
    if (!usage.main_usage_date) usage.main_usage_date = date;
  }
  return { ...store, claims };
}

// ---------------------------------------------------------------------------
// Global wildcard replacement
// ---------------------------------------------------------------------------

export type ReplacementResolution =
  | { ok: true; replacement: Claim; /** true when this call consumed the replacement */ consumedNow: boolean }
  | { ok: false; reason: string };

/**
 * Resolves the permanent replacement for a primary claim.
 *
 * Important distinction (from the spec):
 *  - ASSIGNMENT: the challenge already fixes which claim replaces which. That is
 *    permanent and identical for every player, forever.
 *  - USAGE: the global `used_as_replacement` flag records that the replacement
 *    has been served at least once. It prevents the claim from being consumed as
 *    a replacement for a *different* original, but it must NOT invalidate an
 *    already-established assignment.
 *
 * Therefore a player swapping claim A always receives A's partner, even after
 * another player has already consumed it. `consumedNow` tells the caller whether
 * to write the flag.
 */
export function resolveReplacement(
  library: Claim[],
  store: ClaimUsageStore,
  originalId: string,
  excludeIds: Iterable<string> = [],
): ReplacementResolution {
  const byId = new Map(library.map((claim) => [claim.id, claim]));
  const original = byId.get(originalId);
  if (!original) return { ok: false, reason: 'Unknown claim.' };

  const usage = store.claims[originalId];
  const partnerId = usage?.replacement_claim_id ?? null;
  if (!partnerId) return { ok: false, reason: 'This claim has no permanent replacement assigned.' };

  const replacement = byId.get(partnerId);
  if (!replacement) return { ok: false, reason: 'The assigned replacement is missing from the library.' };
  if (replacement.category !== original.category) {
    return { ok: false, reason: 'The assigned replacement is not in the same verdict.' };
  }
  // A duplicate on the table would make the challenge show the same claim twice.
  if (new Set(excludeIds).has(replacement.id)) {
    return { ok: false, reason: 'The assigned replacement is already in this challenge.' };
  }

  const replacementUsage = store.claims[replacement.id];
  const consumedNow = !replacementUsage?.used_as_replacement;
  return { ok: true, replacement, consumedNow };
}

/** Records a replacement consumption. Never clears an existing flag. */
export function consumeReplacement(
  store: ClaimUsageStore,
  replacementId: string,
  date: string,
): ClaimUsageStore {
  const usage = store.claims[replacementId];
  if (!usage) return store;
  if (usage.used_as_replacement && usage.replacement_usage_date) return store;
  return {
    ...store,
    claims: {
      ...store.claims,
      [replacementId]: {
        ...usage,
        used_as_replacement: true,
        replacement_usage_date: usage.replacement_usage_date ?? date,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type InventoryDiagnostics = {
  totals: Record<Category, number>;
  unusedMain: Record<Category, number>;
  usedMainOnly: Record<Category, number>;
  usedReplacementOnly: Record<Category, number>;
  exhausted: Record<Category, number>;
  availableReplacements: number;
  brokenPairs: string[];
  /** Whole challenges still generatable, after pair constraints. */
  remainingCapacity: number;
  /** Whole challenges still generatable per category, after pair constraints. */
  capacityPerCategory: Record<Category, number>;
};

/**
 * Capacity is computed from the eligible main pool, with the pair rule applied as
 * a secondary cap.
 *
 * A challenge needs 3 claims per category drawn from 3 *distinct* pairs. Since the
 * pair rule only excludes the partner of an already-chosen claim (and pairs are
 * disjoint), a pool of `n` eligible claims covering `p` pairs can supply
 * `min(n, p)` claims per challenge. In practice `n` binds first: the pair rule only
 * costs a day at the very end of a category's life, when fewer than 3 pairs remain.
 */
export function diagnose(library: Claim[], store: ClaimUsageStore): InventoryDiagnostics {
  const zero = (): Record<Category, number> => ({ FACT: 0, KINDA: 0, BULLSHIT: 0 });
  const totals = zero(), unusedMain = zero(), usedMainOnly = zero(), usedReplacementOnly = zero(), exhausted = zero();
  const brokenPairs: string[] = [];

  const byId = new Map(library.map((claim) => [claim.id, claim]));

  for (const claim of library) {
    const usage = store.claims[claim.id] ?? emptyUsage();
    totals[claim.category] += 1;
    if (!usage.used_as_main && !usage.used_as_replacement) unusedMain[claim.category] += 1;
    else if (usage.used_as_main && !usage.used_as_replacement) usedMainOnly[claim.category] += 1;
    else if (!usage.used_as_main && usage.used_as_replacement) usedReplacementOnly[claim.category] += 1;
    else exhausted[claim.category] += 1;

    const partner = usage.replacement_claim_id;
    if (!partner || !byId.has(partner) || byId.get(partner)!.category !== claim.category) {
      brokenPairs.push(claim.id);
    }
  }

  const availableReplacements = library.filter(
    (claim) => !(store.claims[claim.id] ?? emptyUsage()).used_as_replacement,
  ).length;

  const capacityPerCategory = zero();
  for (const category of CATEGORIES) {
    const pool = eligibleMainClaims(library, store, category);
    const pairKeys = new Set<string>();
    for (const claim of pool) {
      const partner = store.claims[claim.id]?.replacement_claim_id;
      pairKeys.add(partner ? [claim.id, partner].sort(compareIds).join('|') : claim.id);
    }
    // Days of supply are bounded by the eligible claim pool (3 claims per challenge).
    // Pair feasibility is a PER-DAY constraint, not a lifetime one: each challenge
    // consumes one claim per pair, but after that challenge the pair still holds one
    // unused member, so it can serve again on a later day. At least 3 distinct pairs
    // must remain available on a given day for that day to be generatable at all.
    const byPool = Math.floor(pool.length / CLAIMS_PER_ROUND);
    const byPairs = pairKeys.size >= CLAIMS_PER_ROUND ? byPool : 0;
    capacityPerCategory[category] = Math.min(byPool, byPairs);
  }
  const remainingCapacity = Math.min(...CATEGORIES.map((category) => capacityPerCategory[category]));

  return {
    totals, unusedMain, usedMainOnly, usedReplacementOnly, exhausted,
    availableReplacements, brokenPairs, remainingCapacity, capacityPerCategory,
  };
}

// ---------------------------------------------------------------------------
// JSON import / export (the two requested data stores)
// ---------------------------------------------------------------------------

export const exportUsageJson = (store: ClaimUsageStore): string =>
  `${JSON.stringify(store, null, 2)}\n`;

export const exportChallengesJson = (store: ChallengeStore): string =>
  `${JSON.stringify(store, null, 2)}\n`;

export function parseUsageJson(text: string): ClaimUsageStore {
  const parsed = JSON.parse(text) as ClaimUsageStore;
  if (!parsed || typeof parsed !== 'object' || typeof parsed.claims !== 'object' || Array.isArray(parsed.claims)) {
    throw new Error('Invalid claim-usage store.');
  }
  return { version: parsed.version ?? INVENTORY_VERSION, reconciled_at: parsed.reconciled_at, claims: parsed.claims };
}

export function parseChallengesJson(text: string): ChallengeStore {
  const parsed = JSON.parse(text) as ChallengeStore;
  if (!parsed || typeof parsed !== 'object' || typeof parsed.challenges !== 'object' || Array.isArray(parsed.challenges)) {
    throw new Error('Invalid daily-challenges store.');
  }
  return { version: parsed.version ?? INVENTORY_VERSION, challenges: parsed.challenges };
}

/** Builds the frozen historical snapshot shape used for archive back-fill. */
export function challengeFromRounds(
  date: string,
  rounds: ChallengeRound[],
  generatedAt: string,
  status: DailyChallenge['status'] = 'active',
): DailyChallenge {
  return { challenge_id: date, generated_at: generatedAt, status, rounds };
}

/** Structural validation of the claim library, run before any pairing. */
export function validateLibrary(library: Claim[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const claim of library) {
    if (seen.has(claim.id)) problems.push(`duplicate claim id: ${claim.id}`);
    seen.add(claim.id);
    if (!CATEGORIES.includes(claim.category)) problems.push(`invalid category for ${claim.id}: ${claim.category}`);
  }
  for (const category of CATEGORIES) {
    const count = library.filter((claim) => claim.category === category).length;
    if (count < ROUNDS_PER_CHALLENGE) problems.push(`category ${category} has only ${count} claims`);
    if (count % 2 !== 0) problems.push(`category ${category} has an odd claim count (${count}) and cannot be fully paired`);
  }
  return problems;
}
